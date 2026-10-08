/** 网关安装的固定版本。升级时改这里，并同步测试里的 URL。 */
export const FRP_VERSION = '0.60.0';
export const NGINX_VERSION = '1.26.3';

export const NGINX_LISTEN_HOST = '127.0.0.1';
export const NGINX_LISTEN_PORT = 8088;
export const FRPS_BIND_ADDR = '0.0.0.0';
export const FRPS_BIND_PORT = 7000;
export const FRPS_DASHBOARD_HOST = '127.0.0.1';
export const FRPS_DASHBOARD_PORT = 7500;
/** nat-tunnel 的远端端口必须落在这段，避免占用系统端口。 */
export const FRPS_ALLOW_PORT_START = 10000;
export const FRPS_ALLOW_PORT_END = 50000;

export interface FrpAsset {
  url: string;
  dirName: string;
  frpsName: string;
  frpcName: string;
}

export interface NginxAsset {
  url: string;
  dirName: string;
  binaryName: string;
}

function frpOs(platform: NodeJS.Platform): string | null {
  if (platform === 'win32') return 'windows';
  if (platform === 'linux') return 'linux';
  if (platform === 'darwin') return 'darwin';
  return null;
}

function frpArch(arch: string): string | null {
  if (arch === 'x64') return 'amd64';
  if (arch === 'arm64') return 'arm64';
  return null;
}

/** 官方 frp 发行包，内含 frps 与 frpc。 */
export function frpAsset(platform: NodeJS.Platform, arch: string): FrpAsset | null {
  const osName = frpOs(platform);
  const archName = frpArch(arch);
  if (!osName || !archName) return null;
  const dirName = `frp_${FRP_VERSION}_${osName}_${archName}`;
  const ext = platform === 'win32' ? 'zip' : 'tar.gz';
  const exe = platform === 'win32' ? '.exe' : '';
  return {
    url: `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${dirName}.${ext}`,
    dirName,
    frpsName: `frps${exe}`,
    frpcName: `frpc${exe}`,
  };
}

/** nginx.org 只提供 Windows 二进制包。其它系统使用已安装的 nginx。 */
export function nginxAsset(platform: NodeJS.Platform): NginxAsset | null {
  if (platform !== 'win32') return null;
  const dirName = `nginx-${NGINX_VERSION}`;
  return {
    url: `https://nginx.org/download/${dirName}.zip`,
    dirName,
    binaryName: 'nginx.exe',
  };
}
