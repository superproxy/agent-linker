/**
 * ilink 微信官方 Bot API 客户端（方案 B botAgent 的微信侧）。
 *
 * 纯 HTTP 直连 ilinkai.weixin.qq.com，不复用 openclaw 插件包——协议细节
 * （headers / body 结构）从 @tencent-weixin/openclaw-weixin@2.4.8 实测提取：
 *   - getUpdates:   POST /ilink/bot/getupdates    长轮询收消息（35s）
 *   - sendMessage:  POST /ilink/bot/sendmessage   主动推送文本/图片
 * 图片出站：getuploadurl 取 CDN 上传参数 → AES-128-ECB 密文传 CDN → sendmessage 发 image_item。
 * 鉴权：Authorization: Bearer <bot_token> + AuthorizationType: ilink_bot_token。
 * 登录态复用现有扫码登录产物（openclaw-weixin/accounts/<id>.json，见 weixin-login.ts）。
 */
import { randomBytes, createHash, createCipheriv } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getLayout } from '../install/layout.js';

export const ILINK_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
/** 图片 CDN 上传主机（novac2c 通道） */
const ILINK_CDN_HOST = 'https://novac2c.cdn.weixin.qq.com';

/** 插件声明的 ilink_appid 与客户端版本（2.4.8 → 0x020408），服务端按此识别调用方 */
const ILINK_APP_ID = 'bot';
const ILINK_APP_CLIENT_VERSION = 0x020408;
const CHANNEL_VERSION = '2.4.8';
const DEFAULT_BOT_AGENT = 'linkagent-bot/0.1.0';

export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
export const DEFAULT_API_TIMEOUT_MS = 15_000;

/** 微信消息类型（proto 常量，与插件 dist/src/api/types.js 一致） */
export const MessageType = { NONE: 0, USER: 1, BOT: 2 } as const;
export const MessageItemType = { NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;

/** 登录态账号（openclaw-weixin/accounts/<id>.json 的结构） */
export interface WeixinAccount {
  id: string;
  token: string;
  baseUrl: string;
  userId: string;
  savedAt: string;
}

function parseAccountFile(dir: string, file: string): WeixinAccount | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
      token?: string;
      baseUrl?: string;
      userId?: string;
      savedAt?: string;
    };
    if (typeof raw.token !== 'string' || !raw.token) return null;
    return {
      id: file.replace(/\.json$/, ''),
      token: raw.token,
      baseUrl: raw.baseUrl ?? ILINK_DEFAULT_BASE_URL,
      userId: raw.userId ?? '',
      savedAt: raw.savedAt ?? '',
    };
  } catch {
    return null;
  }
}

function accountsDirOf(accountsRootDir: string): string {
  return join(accountsRootDir, 'openclaw-weixin', 'accounts');
}

/** 目录内全部带 token 的登录态（跳过 accounts.json / sync / *-tokens） */
export function listWeixinAccounts(accountsRootDir: string): WeixinAccount[] {
  const dir = accountsDirOf(accountsRootDir);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'accounts.json');
  const out: WeixinAccount[] = [];
  for (const file of files) {
    const acc = parseAccountFile(dir, file);
    if (acc) out.push(acc);
  }
  return out;
}

function savedAtMs(acc: WeixinAccount): number {
  const t = Date.parse(acc.savedAt);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 扫码后热更新用：指定了账号槽就必须读到该文件，找不到直接报错，不借用其它登录态。
 * 未指定账号槽时才取 savedAt 最新的一份（无 LINKAGENT_ACCOUNT_ID 的遗留进程）。
 */
export function loadLatestWeixinAccount(accountsRootDir: string, preferredId?: string): WeixinAccount {
  const all = listWeixinAccounts(accountsRootDir);
  const want = preferredId?.trim();
  if (want) {
    const hit = all.find((a) => a.id === want);
    if (!hit) {
      const dir = accountsDirOf(accountsRootDir);
      throw new Error(`未找到 ${want}.json（${dir}）。微信进程不会创建或借用其它登录态。`);
    }
    return hit;
  }
  if (all.length === 0) {
    const dir = accountsDirOf(accountsRootDir);
    throw new Error(`未找到微信登录态目录 ${dir} 或其中没有可用账号；${getLayout().loginHint}`);
  }
  return all.reduce((best, a) => (savedAtMs(a) >= savedAtMs(best) ? a : best));
}

/**
 * 从 <dir>/openclaw-weixin/accounts/ 加载登录态账号。
 * 显式 accountId 时加载指定文件；缺省扫描目录，选择含 token 字段的账号文件
 * （跳过 accounts.json / *.sync.json / *.context-tokens.json 等非账号产物）。
 */
export function loadWeixinAccount(accountsRootDir: string, accountId?: string): WeixinAccount {
  const dir = accountsDirOf(accountsRootDir);
  if (!existsSync(dir)) {
    throw new Error(`未找到微信登录态目录 ${dir}；${getLayout().loginHint}`);
  }
  if (accountId) {
    const acc = parseAccountFile(dir, `${accountId}.json`);
    if (acc) return acc;
    throw new Error(`登录态目录 ${dir} 中没有可用账号（找不到 ${accountId}.json）；${getLayout().loginHint}`);
  }
  const all = listWeixinAccounts(accountsRootDir);
  if (all.length === 0) {
    throw new Error(`登录态目录 ${dir} 中没有可用账号；${getLayout().loginHint}`);
  }
  return all[0]!;
}

/** X-WECHAT-UIN：随机 uint32 → 十进制字符串 → base64（每请求随机） */
function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function buildBaseInfo(): { channel_version: string; bot_agent: string } {
  return { channel_version: CHANNEL_VERSION, bot_agent: DEFAULT_BOT_AGENT };
}

function buildHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${token.trim()}`,
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  };
}

interface PostResult {
  ret: number;
  errcode?: number;
  errmsg?: string;
  [key: string]: unknown;
}

async function postJson(baseUrl: string, endpoint: string, token: string, body: unknown, timeoutMs: number): Promise<PostResult> {
  const url = new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: 'POST',
      headers: buildHeaders(token),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const rawText = await res.text();
  if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}: ${rawText.slice(0, 300)}`);
  return JSON.parse(rawText) as PostResult;
}

/** 告诉微信这个 bot 客户端已停止。失败不阻断本地清登录态。 */
export async function notifyBotStop(account: { baseUrl?: string; token: string }): Promise<void> {
  const token = account.token.trim();
  if (!token) return;
  await postJson(account.baseUrl || ILINK_DEFAULT_BASE_URL, 'ilink/bot/msg/notifystop', token, { base_info: buildBaseInfo() }, 8_000);
}

/** ilink 登录态失效：继续用旧 token 轮询只会打出 session timeout */
export function isIlinkSessionExpired(resp: { errcode?: number; errmsg?: string }): boolean {
  if (resp.errcode === -14) return true;
  const msg = (resp.errmsg ?? '').toLowerCase();
  return msg.includes('session timeout') || msg.includes('session expired');
}

export interface GetUpdatesParams {
  baseUrl: string;
  token: string;
  getUpdatesBuf?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export interface GetUpdatesResult {
  ret: number;
  msgs: WeixinInboundMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
  errcode?: number;
  errmsg?: string;
}

/** 语音 item（对齐插件 VoiceItem：服务端带语音转写 text，无需本地 ASR） */
export interface WeixinVoiceItem {
  /** 语音转文字内容（服务端已转写） */
  text?: string;
  /** 语音长度（毫秒） */
  playtime?: number;
  /** 编码类型：1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex */
  encode_type?: number;
  sample_rate?: number;
}

/** 入站消息（getUpdates msgs[] 元素） */
export interface WeixinInboundMessage {
  from_user_id: string;
  to_user_id?: string;
  client_id?: string;
  message_type?: number;
  message_state?: number;
  context_token?: string;
  run_id?: string;
  item_list?: Array<{
    type: number;
    text_item?: { text: string };
    voice_item?: WeixinVoiceItem;
    image_item?: { url?: string };
    ref_msg?: { title?: string };
    [key: string]: unknown;
  }>;
}

/**
 * 长轮询收消息。服务端挂起请求直到有新消息或超时（35s 正常，ret=0 空响应需重试）。
 */
export async function getUpdates(params: GetUpdatesParams): Promise<GetUpdatesResult> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  params.abortSignal?.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const resp = await postJson(params.baseUrl, 'ilink/bot/getupdates', params.token, {
      get_updates_buf: params.getUpdatesBuf ?? '',
      base_info: buildBaseInfo(),
    }, timeoutMs);
    return resp as unknown as GetUpdatesResult;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError' && !params.abortSignal?.aborted) {
      // 客户端长轮询超时是正常控制流：返回空响应让调用方重试
      return { ret: 0, msgs: [], get_updates_buf: params.getUpdatesBuf ?? '' };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface SendTextParams {
  baseUrl: string;
  token: string;
  to: string;
  text: string;
  contextToken?: string;
  runId?: string;
  timeoutMs?: number;
}

/**
 * 主动推送一条纯文本消息（message_type=BOT, message_state=FINISH）。
 * 返回 client_id（可作为消息 id）。ret!=0 抛错。
 */
export async function sendText(params: SendTextParams): Promise<{ messageId: string }> {
  const clientId = `linkagent-${randomBytes(8).toString('hex')}`;
  const msg = {
    from_user_id: '',
    to_user_id: params.to,
    client_id: clientId,
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    item_list: params.text
      ? [{ type: MessageItemType.TEXT, text_item: { text: params.text } }]
      : [],
    ...(params.contextToken ? { context_token: params.contextToken } : {}),
    ...(params.runId ? { run_id: params.runId } : {}),
  };
  const resp = await postJson(params.baseUrl, 'ilink/bot/sendmessage', params.token, {
    msg,
    base_info: buildBaseInfo(),
  }, params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS);
  if (resp.ret && resp.ret !== 0) {
    throw new Error(`sendMessage ret=${resp.ret} errmsg=${resp.errmsg ?? '(none)'}`);
  }
  return { messageId: clientId };
}

// ── 图片出站（CDN 加密上传 + image_item 推送） ───────────────────────────

/** AES-128-ECB + PKCS7 填充加密（ilink 媒体通道固定算法） */
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export interface SendImageParams {
  baseUrl: string;
  token: string;
  to: string;
  /** JPEG/PNG 等图片明文 */
  image: Buffer;
  contextToken?: string;
  runId?: string;
  timeoutMs?: number;
}

/**
 * 主动推送一张图片：getuploadurl → CDN 上传密文 → sendmessage 发 image_item。
 * 返回 client_id。ret!=0 或上传失败抛错。
 */
export async function sendImage(params: SendImageParams): Promise<{ messageId: string }> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const fileKey = randomBytes(16).toString('hex');
  const aesKey = randomBytes(16); // 16 字节原始 key
  const rawSize = params.image.length;
  const rawMd5 = createHash('md5').update(params.image).digest('hex');
  const ciphertext = encryptAesEcb(params.image, aesKey);

  // 1) 申请 CDN 上传参数
  const upResp = await postJson(params.baseUrl, 'ilink/bot/getuploadurl', params.token, {
    filekey: fileKey,
    media_type: 1, // 1=IMG
    to_user_id: params.to,
    rawsize: rawSize,
    rawfilemd5: rawMd5,
    filesize: ciphertext.length,
    no_need_thumb: true,
    aeskey: aesKey.toString('hex'),
    base_info: buildBaseInfo(),
  }, timeoutMs);
  if (upResp.ret && upResp.ret !== 0) {
    throw new Error(`getuploadurl ret=${upResp.ret} errmsg=${upResp.errmsg ?? '(none)'}`);
  }
  const uploadParam = (upResp as { upload_param?: string }).upload_param;
  if (!uploadParam) throw new Error('getuploadurl 未返回 upload_param');

  // 2) CDN 上传密文（响应头 x-encrypted-param 为下载凭据）
  const cdnUrl = `${ILINK_CDN_HOST}/c2c/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(fileKey)}`;
  const cdnController = new AbortController();
  const cdnTimer = setTimeout(() => cdnController.abort(), timeoutMs);
  let cdnRes: Response;
  try {
    cdnRes = await fetch(cdnUrl, {
      method: 'POST',
      headers: { ...buildHeaders(params.token), 'Content-Type': 'application/octet-stream' },
      body: ciphertext,
      signal: cdnController.signal,
    });
  } finally {
    clearTimeout(cdnTimer);
  }
  if (!cdnRes.ok) throw new Error(`CDN upload HTTP ${cdnRes.status}: ${(await cdnRes.text()).slice(0, 300)}`);
  const encryptQueryParam = cdnRes.headers.get('x-encrypted-param');
  if (!encryptQueryParam) throw new Error('CDN upload 未返回 x-encrypted-param 响应头');

  // 3) sendmessage 发 image_item（aes_key = base64(hex 字符串)）
  const clientId = `linkagent-${randomBytes(8).toString('hex')}`;
  const msg = {
    from_user_id: '',
    to_user_id: params.to,
    client_id: clientId,
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    item_list: [
      {
        type: MessageItemType.IMAGE,
        image_item: {
          media: {
            encrypt_query_param: encryptQueryParam,
            aes_key: Buffer.from(aesKey.toString('hex'), 'utf8').toString('base64'),
            encrypt_type: 1,
          },
          mid_size: ciphertext.length,
        },
      },
    ],
    ...(params.contextToken ? { context_token: params.contextToken } : {}),
    ...(params.runId ? { run_id: params.runId } : {}),
  };
  const resp = await postJson(params.baseUrl, 'ilink/bot/sendmessage', params.token, {
    msg,
    base_info: buildBaseInfo(),
  }, timeoutMs);
  if (resp.ret && resp.ret !== 0) {
    throw new Error(`sendMessage ret=${resp.ret} errmsg=${resp.errmsg ?? '(none)'}`);
  }
  return { messageId: clientId };
}

/**
 * 从入站消息提取正文（对齐官方插件 bodyFromItemList 的文本部分）：
 * - TEXT：直接取文本（多段拼接，行为与旧版一致）
 * - VOICE：优先用服务端语音转写 text；无转写降级为占位
 * - IMAGE / FILE / VIDEO：占位描述（当前不做 CDN 下载与视觉理解）
 */
export function extractText(msg: WeixinInboundMessage): string {
  const parts: string[] = [];
  for (const item of msg.item_list ?? []) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      parts.push(item.text_item.text);
      continue;
    }
    if (item.type === MessageItemType.VOICE) {
      const t = item.voice_item?.text;
      parts.push(t?.trim() ? `[语音转写: ${t.trim()}]` : '[语音消息]');
      continue;
    }
    if (item.type === MessageItemType.IMAGE) parts.push('[图片]');
    else if (item.type === MessageItemType.FILE) parts.push('[文件]');
    else if (item.type === MessageItemType.VIDEO) parts.push('[视频]');
  }
  return parts.join('');
}
