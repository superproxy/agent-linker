# LinkAgent 的 code-server。工作目录是 /root/workspace，宿主机目录在启动时挂进来。
FROM codercom/code-server:4.140.0

USER root

# 当前 Active LTS（Krypton）。npm 随 Node 发行包一起安装，镜像里不再全局装 pnpm。
ARG NODE_VERSION=24.21.0
ARG FRP_VERSION=0.60.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils \
    xvfb x11vnc novnc python3-websockify openbox xterm fonts-dejavu-core fonts-wqy-microhei chromium \
  && arch="$(dpkg --print-architecture)" \
  && case "$arch" in \
       amd64) node_arch=x64; frp_arch=amd64 ;; \
       arm64) node_arch=arm64; frp_arch=arm64 ;; \
       *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
     esac \
  && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1 \
  && curl -fsSL "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${frp_arch}.tar.gz" \
    | tar -xz -C /tmp \
  && mv "/tmp/frp_${FRP_VERSION}_linux_${frp_arch}/frpc" /usr/local/bin/frpc \
  && chmod +x /usr/local/bin/frpc \
  && fc-cache -f \
  && rm -rf /tmp/frp_${FRP_VERSION}_linux_${frp_arch} /var/lib/apt/lists/* /root/.npm \
    /usr/local/include /usr/share/doc /usr/share/man /usr/share/info /usr/share/locale

COPY entrypoint.sh /usr/local/bin/linkagent-entrypoint.sh
RUN chmod +x /usr/local/bin/linkagent-entrypoint.sh

WORKDIR /root/workspace
EXPOSE 8080 5173 6080
ENTRYPOINT ["/usr/local/bin/linkagent-entrypoint.sh"]
CMD ["--auth", "none", "--bind-addr", "0.0.0.0:8080", "--trusted-origins", "*.localhost:8088", "--abs-proxy-base-path", "/vibe-ide", "/root/workspace"]
