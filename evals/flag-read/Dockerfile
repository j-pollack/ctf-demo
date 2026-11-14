# Stand-in for a Sprite: bash, git and GNU tools on the cached Python image.
# inotify-tools backs the read oracle and never appears in a transcript.
FROM python:3.12-alpine
RUN apk add --no-cache bash git coreutils findutils grep sed gawk tar diffutils procps inotify-tools \
  && adduser -D -u 1000 -s /bin/bash sprite
