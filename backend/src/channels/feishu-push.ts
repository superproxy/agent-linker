/**
 * 飞书回复推送：CardKit 流式卡片。新文本必须是旧文本的延伸，才会打字机输出。
 * 创建或更新失败时标记 failed，调用方改回一次性文本回复。
 */

export const FEISHU_ELEMENT_ID = 'content';
/** 单个 markdown 组件的流式更新上限。超过后另开一张卡片。 */
export const FEISHU_STREAM_ELEMENT_LIMIT = 30_000;

export interface FeishuCardApi {
  createCard(cardJson: string): Promise<string>;
  replyCard(messageId: string, cardId: string): Promise<void>;
  updateContent(cardId: string, elementId: string, content: string, sequence: number): Promise<void>;
  closeStream(cardId: string, sequence: number): Promise<void>;
}

export function streamingCardData(content: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: { streaming_mode: true, update_multi: true },
    body: {
      elements: [{ tag: 'markdown', content, element_id: FEISHU_ELEMENT_ID }],
    },
  });
}

export function replyCardContent(cardId: string): string {
  return JSON.stringify({ type: 'card', data: { card_id: cardId } });
}

export function closeStreamSettings(): string {
  return JSON.stringify({ config: { streaming_mode: false } });
}

/** 思考块和失败摘要仍走文本回复，不写进流式卡片。 */
export function isFeishuStatusChunk(chunk: string): boolean {
  return chunk.startsWith('🤔') || chunk.startsWith('⚠️');
}

export class FeishuTextStream {
  private sequence = 0;
  /** 已经写进已关闭卡片的字符数。当前卡片只显示这之后的一段。 */
  private committed = 0;
  private shown = '';
  private cardId = '';
  private lastPushAt = 0;
  /** 已把卡片回复到会话里 */
  started = false;
  /** 创建卡片失败，改走文本回复 */
  failed = false;

  constructor(
    private readonly api: FeishuCardApi,
    private readonly messageId: string,
    private readonly now: () => number = Date.now,
    private readonly minIntervalMs = 400,
  ) {}

  async push(fullText: string): Promise<void> {
    if (this.failed) return;
    const text = fullText.trimEnd();
    if (!text) return;
    if (!this.started) {
      await this.open(text);
      return;
    }
    if (text.length === this.committed + this.shown.length) return;
    const due = this.now() - this.lastPushAt >= this.minIntervalMs;
    const grown = text.length - this.committed - this.shown.length >= 80;
    if (!due && !grown) return;
    await this.write(text);
  }

  async finish(fullText: string): Promise<void> {
    if (this.failed || !this.started) return;
    const text = fullText.trimEnd();
    if (text && text.length !== this.committed + this.shown.length) await this.write(text);
    this.sequence += 1;
    await this.api.closeStream(this.cardId, this.sequence);
  }

  private async open(text: string): Promise<void> {
    const slice = text.slice(this.committed, this.committed + FEISHU_STREAM_ELEMENT_LIMIT);
    try {
      const cardId = await this.api.createCard(streamingCardData(slice));
      await this.api.replyCard(this.messageId, cardId);
      this.cardId = cardId;
      this.shown = slice;
      this.started = true;
      this.lastPushAt = this.now();
      if (text.length > this.committed + slice.length) await this.write(text);
    } catch (err) {
      this.failed = true;
      throw err;
    }
  }

  private async write(text: string): Promise<void> {
    const end = Math.min(text.length, this.committed + FEISHU_STREAM_ELEMENT_LIMIT);
    const next = text.slice(this.committed, end);
    if (next !== this.shown) {
      this.sequence += 1;
      await this.api.updateContent(this.cardId, FEISHU_ELEMENT_ID, next, this.sequence);
      this.shown = next;
      this.lastPushAt = this.now();
    }
    if (text.length <= this.committed + this.shown.length) return;
    this.sequence += 1;
    await this.api.closeStream(this.cardId, this.sequence);
    this.committed += this.shown.length;
    this.shown = '';
    this.cardId = '';
    this.started = false;
    this.sequence = 0;
    await this.open(text);
  }
}
