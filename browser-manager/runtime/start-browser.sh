#!/bin/sh
set -eu

mkdir -p "$HOME" /tmp/.X11-unix
chmod 0700 "$HOME"

Xvfb :99 -screen 0 1440x1000x24 -nolisten tcp &

for attempt in $(seq 1 200); do
  if xdpyinfo -display :99 >/dev/null 2>&1; then
    break
  fi
  sleep 0.025
done

# Current Chrome binds DevTools to loopback even when an external address is
# requested. Keep Chrome on container loopback and expose only this narrow
# relay through Docker's host-loopback port mapping.
socat TCP-LISTEN:9222,fork,reuseaddr TCP:127.0.0.1:9223 &

exec dbus-run-session -- google-chrome-stable \
  --user-data-dir=/profile \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9223 \
  --remote-allow-origins=* \
  --password-store=basic \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-mode \
  --disable-breakpad \
  --disable-crash-reporter \
  --disable-features=Translate \
  --restore-last-session \
  --start-maximized
