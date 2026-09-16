FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl dbus-x11 gnupg socat x11-utils xvfb \
  && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
     | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
     > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 10001 --shell /usr/sbin/nologin chrome \
  && install -d -o chrome -g chrome -m 0700 /profile /downloads \
  && install -d -m 0755 /etc/opt/chrome/policies/managed \
  && printf '%s\n' '{"DownloadDirectory":"/downloads","PromptForDownload":false,"SafeBrowsingProtectionLevel":1,"AlwaysOpenPdfExternally":false}' \
     > /etc/opt/chrome/policies/managed/veneer-browser.json

COPY start-browser.sh /usr/local/bin/start-browser
RUN chmod 0755 /usr/local/bin/start-browser

USER chrome
ENV HOME=/tmp/chrome-home DISPLAY=:99
EXPOSE 9222
ENTRYPOINT ["/usr/local/bin/start-browser"]
