# A DSH web instance with this plugin installed, for hand-driven acceptance.
#
# Nothing here is a build step that could hang: seeding a profile means booting it once,
# and the plugin is installed through `dsh plugin`, which shells out to pnpm. Both happen
# at start-up instead (see entrypoint.sh), against a volume, so the image stays a plain
# Node + git + DSH install.
#
# The base image comes through the daocloud mirror and apt through tuna, because on the
# machine this was built on Docker Hub's registry is DNS-polluted and Debian's default
# mirror 404s. Both were measured in this repository's sibling projects; a machine
# without those problems can drop the prefixes.
FROM docker.m.daocloud.io/library/node:22-bookworm-slim

RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The DSH the plugin declares itself compatible with, and the package manager `dsh plugin`
# runs. `npm --prefix` rather than a global install: the entry point is then a path this
# image knows, and nothing depends on where npm decided to put a bin.
ARG DSH_VERSION=0.2.0-rc.2
RUN npm install --global pnpm@10 \
 && npm install --prefix /opt/dsh "@deepseek-ai/dsh@${DSH_VERSION}" \
 && node -e "require('fs').accessSync('/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')"

ENV DSH_HOME=/dsh \
    DSH_BIN=/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
    DSH_VERSION=${DSH_VERSION} \
    PORT=34822

COPY dsh-worktree-space-1.2.1.tgz /tmp/plugin.tgz
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 34822
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
