# The runner of Xiero Nexus AI: the place programs and builds run in, apart
# from the app (server.mjs). The CONTAINER is the boundary: run it with the
# flags of the README, or let scripts/host/runner-service.sh do it on a
# Pterodactyl node.
#
# What is in it: Node.js and npm, Python with pip and pytest, git, and for
# what is built into a package: JDK 21 (and 17 and 25 where Debian has them),
# Maven, and Gradle 8 and 9.
FROM debian:trixie-slim

# Gradle as its makers publish it, checked against the sums they publish.
ARG GRADLE_8=8.14.5
ARG GRADLE_8_SHA256=6f74b601422d6d6fc4e1f9a1ab6522f642c2fdcbc15ae33ebd30ba3d7198e854
ARG GRADLE_9=9.9.2
ARG GRADLE_9_SHA256=971fcd7150ca4ba04852c0b2ca0d2d0ab9468e14b03473eab19528809914c76b
# What is fetched once, here, so that a build does not fetch it every time:
# the Paper API in these versions, each with the Java it is compiled for.
# Empty: nothing is fetched ahead.
ARG WARM_PAPER="1.20.4:17 1.21.4:21 1.21.8:21"

# A list of packages that could not be fetched ends the build there, with the
# reason, and not later with "Unable to locate package". The JDKs besides 21
# are taken where this Debian has them.
RUN apt-get -o APT::Update::Error-Mode=any update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip zip git iptables \
      nodejs npm python3 python3-pip python3-venv python3-pytest \
      openjdk-21-jdk-headless maven \
 && for version in 17 25; do \
      apt-get install -y --no-install-recommends "openjdk-${version}-jdk-headless" \
        || echo "JDK ${version} is not among the packages of this Debian: left out."; \
    done \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/java \
 && for home in /usr/lib/jvm/java-*-openjdk-*; do \
      version="$(basename "${home}" | sed -n 's/^java-\([0-9][0-9]*\)-openjdk-.*/\1/p')"; \
      if [ -n "${version}" ] && [ -x "${home}/bin/javac" ]; then ln -sfn "${home}" "/opt/java/${version}"; fi; \
    done \
 && [ -x /opt/java/21/bin/javac ] \
 && echo "JDKs: $(ls /opt/java | sort -n | tr '\n' ' ')"

RUN set -eu; \
    fetch() { \
      curl -fsSL --retry 3 --connect-timeout 20 -o "$2" "https://github.com/gradle/gradle-distributions/releases/download/v$1/gradle-$1-bin.zip" \
        || curl -fsSL --retry 3 --connect-timeout 20 -o "$2" "https://services.gradle.org/distributions/gradle-$1-bin.zip"; \
    }; \
    mkdir -p /opt/gradle; \
    for pair in "${GRADLE_8}:${GRADLE_8_SHA256}" "${GRADLE_9}:${GRADLE_9_SHA256}"; do \
      version="${pair%%:*}"; sum="${pair#*:}"; \
      fetch "${version}" /tmp/gradle.zip; \
      echo "${sum}  /tmp/gradle.zip" | sha256sum -c -; \
      unzip -q /tmp/gradle.zip -d /opt/gradle; \
      rm /tmp/gradle.zip; \
      ln -sfn "/opt/gradle/gradle-${version}" "/opt/gradle/${version%%.*}"; \
    done

ENV JAVA_HOME=/opt/java/21 \
    PATH=/usr/local/bin:/opt/java/21/bin:/usr/bin:/bin:/usr/sbin:/sbin \
    LANG=C.UTF-8 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

# "gradle" is Gradle 8, or Gradle 9 for a project whose
# gradle/wrapper/gradle-wrapper.properties names a version 9 or newer.
COPY gradle.sh /usr/local/bin/gradle
RUN chmod 755 /usr/local/bin/gradle

# What every run finds in its home: the settings of the build tools. Gradle
# is told where the JDKs are, and not to fetch another.
RUN mkdir -p /opt/runner/home/.gradle \
 && { \
      echo "org.gradle.daemon=false"; \
      echo "org.gradle.vfs.watch=false"; \
      echo "org.gradle.welcome=never"; \
      echo "org.gradle.jvmargs=-Xmx768m -XX:MaxMetaspaceSize=384m -Dfile.encoding=UTF-8"; \
      echo "org.gradle.java.installations.auto-download=false"; \
      echo "org.gradle.java.installations.paths=$(ls -d /opt/java/* | tr '\n' ',' | sed 's/,$//')"; \
    } > /opt/runner/home/.gradle/gradle.properties

# Fetched ahead (see WARM_PAPER): a small Paper plugin is built once for each
# version, with Gradle 8 and with Gradle 9, and a small Maven project once.
# What that fetched is kept where every run reads it and none can write. A
# version that cannot be fetched now is left out: its builds fetch it
# themselves.
COPY warm /opt/runner/warm
RUN set -eu; \
    export GRADLE_USER_HOME=/tmp/warm-gradle; \
    mkdir -p "${GRADLE_USER_HOME}" /opt/gradle-ro /opt/maven-ro; \
    cp /opt/runner/home/.gradle/gradle.properties "${GRADLE_USER_HOME}/"; \
    for one in ${WARM_PAPER}; do \
      paper="${one%%:*}"; java="${one#*:}"; \
      if [ ! -d "/opt/java/${java}" ]; then echo "warm: Paper ${paper} wants JDK ${java}, which is not here: left out."; continue; fi; \
      for major in 8 9; do \
        rm -rf /tmp/warm-project; cp -r /opt/runner/warm/paper /tmp/warm-project; \
        sed -i "s/@PAPER@/${paper}/g; s/@JAVA@/${java}/g" /tmp/warm-project/build.gradle.kts /tmp/warm-project/src/main/resources/plugin.yml; \
        if "/opt/gradle/${major}/bin/gradle" -p /tmp/warm-project build -x test --console=plain -q; then \
          echo "warm: Paper ${paper} (Java ${java}) with Gradle ${major}: fetched."; \
        else \
          echo "warm: Paper ${paper} (Java ${java}) with Gradle ${major} could not be built now: left out."; \
        fi; \
      done; \
    done; \
    if [ -d "${GRADLE_USER_HOME}/caches/modules-2" ]; then \
      cp -a "${GRADLE_USER_HOME}/caches/modules-2" /opt/gradle-ro/modules-2; \
      find /opt/gradle-ro -name '*.lock' -delete; \
      find /opt/gradle-ro -name 'gc.properties' -delete; \
    fi; \
    if mvn -B -ntp -q -DskipTests -Dmaven.repo.local=/opt/maven-ro -f /opt/runner/warm/maven/pom.xml package; then \
      echo "warm: what Maven builds a jar with: fetched."; \
    else \
      echo "warm: the Maven project could not be built now: left out."; \
    fi; \
    rm -rf /opt/runner/warm/maven/target /tmp/warm-gradle /tmp/warm-project /root/.m2 /root/.gradle /root/.kotlin; \
    chmod -R a+rX /opt/gradle-ro /opt/maven-ro /opt/runner; \
    echo "warm: $(du -sh /opt/gradle-ro | cut -f1) for Gradle, $(du -sh /opt/maven-ro | cut -f1) for Maven."

ENV GRADLE_RO_DEP_CACHE=/opt/gradle-ro \
    MAVEN_ARGS="-Dmaven.repo.local.tail=/opt/maven-ro -Dmaven.repo.local.tail.ignoreAvailability=true"

COPY server.mjs selftest.mjs /srv/
COPY init.sh /srv/init.sh
RUN chmod 755 /srv/init.sh && mkdir -p /work && chmod 711 /work

ENV PORT=8080 \
    WORK_BASE=/work
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
# init.sh closes the network to private addresses when it is told to
# (RUNNER_FIREWALL=1, which needs the right to do so), and starts the server.
ENTRYPOINT ["/srv/init.sh"]
