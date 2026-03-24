
# Build mapgen in a container
FROM ubuntu:22.04 AS build

ENV DEBIAN_FRONTEND=noninteractive

RUN printf 'nameserver 8.8.8.8\nnameserver 8.8.4.4\n' > /etc/resolv.conf \
    && printf 'Acquire::Retries "5";\nAcquire::ForceIPv4 "true";\n' > /etc/apt/apt.conf.d/80-networking \
    && apt-get update \
    && apt-get install --no-install-recommends --no-install-suggests -y git mingw-w64 python3-minimal \
    && rm -rf /var/lib/apt/lists/*

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
RUN printf 'nameserver 8.8.8.8\nnameserver 8.8.4.4\n' > /etc/resolv.conf \
    && printf 'Acquire::Retries "5";\nAcquire::ForceIPv4 "true";\n' > /etc/apt/apt.conf.d/80-networking \
    && dpkg --add-architecture i386 \
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
RUN printf 'nameserver 8.8.8.8\nnameserver 8.8.4.4\n' > /etc/resolv.conf \
    && npm install canvas@3.2.1

ADD dist/ /app/

COPY --from=build /build/bin/ /app/bin/

ARG GIT_VERSION
ENV GIT_VERSION=${GIT_VERSION}

ARG GIT_HASH
ENV GIT_HASH=${GIT_HASH}

# Make sure InstallPath exists inside the registry
COPY d2.install.reg /app/
CMD ["node", "index.cjs"]
