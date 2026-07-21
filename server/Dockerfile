FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/ola-remote ./cmd/server

FROM alpine:3.21
RUN addgroup -S ola && adduser -S ola -G ola
COPY --from=build /out/ola-remote /usr/local/bin/ola-remote
USER ola
EXPOSE 7300 7301
ENTRYPOINT ["/usr/local/bin/ola-remote"]
