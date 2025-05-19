###################
# STAGE 1: builder
###################

FROM node:22-bullseye AS builder

ARG MB_EDITION=oss
ARG VERSION

WORKDIR /home/node

RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y wget apt-transport-https gpg curl git \
  && wget -qO - https://packages.adoptium.net/artifactory/api/gpg/key/public \
       | gpg --dearmor \
       | tee /etc/apt/trusted.gpg.d/adoptium.gpg >/dev/null \
  && echo "deb https://packages.adoptium.net/artifactory/deb \
       $(awk -F= '/^VERSION_CODENAME/{print $2}' /etc/os-release) main" \
       | tee /etc/apt/sources.list.d/adoptium.list \
  && apt-get update \
  && apt-get install -y temurin-21-jdk \
  && curl -O https://download.clojure.org/install/linux-install-1.12.0.1488.sh \
  && chmod +x linux-install-1.12.0.1488.sh \
  && ./linux-install-1.12.0.1488.sh \
  && rm linux-install-1.12.0.1488.sh

COPY . .

# Ensure Git operations work in this owned directory
RUN git config --global --add safe.directory /home/node

# Build the frontend & the uberjar
RUN yarn --frozen-lockfile \
  && INTERACTIVE=false CI=true MB_EDITION=$MB_EDITION \
     bin/build.sh :version ${VERSION}


####################
# STAGE 2: runner
####################

FROM eclipse-temurin:21-jre-alpine AS runner

ENV FC_LANG=en-US \
    LC_CTYPE=en_US.UTF-8

# Install dependencies & certs
RUN apk add --no-cache \
      bash fontconfig curl font-noto font-noto-arabic font-noto-hebrew \
      font-noto-cjk java-cacerts \
  && mkdir -p /app/certs /plugins \
  && curl -sSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
       -o /app/certs/rds-combined-ca-bundle.pem \
  && keytool -noprompt -import -trustcacerts \
       -alias aws-rds \
       -file /app/certs/rds-combined-ca-bundle.pem \
       -keystore /etc/ssl/certs/java/cacerts \
       -storepass changeit \
  && curl -sSL https://cacerts.digicert.com/DigiCertGlobalRootG2.crt.pem \
       -o /app/certs/DigiCertGlobalRootG2.crt.pem \
  && keytool -noprompt -import -trustcacerts \
       -alias digicert-root \
       -file /app/certs/DigiCertGlobalRootG2.crt.pem \
       -keystore /etc/ssl/certs/java/cacerts \
       -storepass changeit \
  && chmod a+rwx /plugins \
  && rm -rf /var/cache/apk/*

# Copy over the built uberjar
COPY --from=builder /home/node/target/uberjar/metabase.jar /app/metabase.jar

# Make the jar world-readable at build-time
RUN chmod o+r /app/metabase.jar

# Tell Jetty (Metabase’s web server) to bind to Railway’s $PORT
ENV MB_JETTY_PORT=$PORT

# Tune the JVM heap via Railway’s JAVA_OPTS variable (set in Railway UI)
# e.g.: -Xms128m -Xmx384m on Free tier
ENV JAVA_OPTS="${JAVA_OPTS:-}"

# Expose the default port (for documentation; Railway uses $PORT internally)
EXPOSE 3000

# Minimal entrypoint: expand $PORT and $JAVA_OPTS, then run
ENTRYPOINT ["/bin/sh", "-c", "exec java $JAVA_OPTS -jar /app/metabase.jar"]
