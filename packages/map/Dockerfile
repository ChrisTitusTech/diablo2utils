
# Build mapgen in a container
FROM ubuntu:22.04 AS build

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install --no-install-recommends --no-install-suggests git -y \
    mingw-w64

RUN mkdir -p /build/map
COPY ./map /build/map
COPY ./build.mapgen.sh /build

WORKDIR /build
ARG GIT_VERSION
ENV GIT_VERSION=${GIT_VERSION}

ARG GIT_HASH
ENV GIT_HASH=${GIT_HASH}

RUN bash build.mapgen.sh

# Runtime: Ubuntu 22.04 with Wine and Node.js
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV WINEARCH=win32
ENV WINEDEBUG=-all

# Enable 32-bit architecture required by Wine
RUN dpkg --add-architecture i386 \
    && apt-get update -yq \
    && apt-get install -yq --no-install-recommends \
        ca-certificates curl gnupg \
        wine wine32 wine64 \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -yq nodejs \
    && rm -rf /var/lib/apt/lists/*

VOLUME [ "/app/game" ]

WORKDIR /app
RUN npm init --yes
RUN npm install canvas@3.2.1

ADD dist/ /app/

COPY --from=build /build/bin/ /app/bin/

ARG GIT_VERSION
ENV GIT_VERSION=${GIT_VERSION}

ARG GIT_HASH
ENV GIT_HASH=${GIT_HASH}

# Make sure InstallPath exists inside the registry
COPY d2.install.reg /app/
CMD ["node", "index.cjs"]
