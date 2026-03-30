# Deployment Port Architecture

이 문서는 현재 3개 레포가 어떤 포트/URL 관계로 동작하는지, 그리고 어디가 설정의 원본인지 짧게 정리한다.

## Single Source Of Truth

현재 원칙은 다음과 같다.

- runtime 코드 안에는 host:port fallback 을 두지 않는다.
- 실제 host:port 값은 각 레포의 `docker-compose.yml` 또는 `docker-compose.dev.yml` 에서만 관리한다.
- 코드에서는 compose 가 주입한 env URL 만 읽는다.

## Current Port Map

- frontend: `12300`
- Steel API: `12200`
- control-plane: `12210`

## Repo Responsibilities

### steel-browser

설정 파일:

- `docker-compose.yml`
- `docker-compose.dev.yml`

주요 env:

- `APP_HOST`
- `STEEL_API_PORT`
- `DOMAIN`
- `CHROME_HEADLESS`

현재 canonical 실행:

```bash
docker compose up -d --build
```

이유:

- 기본 `docker-compose.yml` 도 이제 로컬 `api/` 이미지를 build 한다.
- 그래서 plain `docker compose up` 경로에서도 최신 API 런타임 변경이 반영된다.

기본 session/runtime defaults:

- `CHROME_HEADLESS=true`
- fresh session dimensions: `1356x763`

headful/Xvfb 가 필요하면 예시:

```bash
CHROME_HEADLESS=false docker compose up -d --build
```

### control-plane

설정 파일:

- `docker-compose.yml`

주요 env:

- `APP_HOST`
- `FRONTEND_PORT`
- `STEEL_API_PORT`
- `CONTROL_PLANE_PORT`
- `STEEL_API_BASE_URL`
- `CONTROL_PLANE_CORS_ALLOW_ORIGINS`

### frontend

설정 파일:

- `docker-compose.yml`

주요 env:

- `APP_HOST`
- `FRONTEND_PORT`
- `STEEL_API_PORT`
- `CONTROL_PLANE_PORT`
- `STEEL_API_BASE_URL`
- `NEXT_PUBLIC_STEEL_API_BASE_URL`
- `NEXT_PUBLIC_CONTROL_PLANE_BASE_URL`

## Runtime Flow

1. 브라우저 사용자는 `frontend`(`12300`)에 접속한다.
2. frontend 는 compose 가 넣은 `NEXT_PUBLIC_CONTROL_PLANE_BASE_URL` 로 control-plane 에 붙는다.
3. control-plane 은 compose 가 넣은 `STEEL_API_BASE_URL` 로 Steel API 에 붙는다.
4. Steel API 는 `12200` 에서 session/live-details/cast viewer/debug 를 노출한다.

## Verified Flow

현재 실제 검증이 끝난 흐름:

1. Steel session 생성
2. `/pageid/[id]` 진입
3. live shell / cast 표시
4. navigate -> `https://example.com/`
5. navigate button -> `https://www.fmkorea.com/`
6. authoring start -> `POST /api/v1/authoring/start` `200`

## Notes

- runtime 코드에서는 더 이상 `192.168.50.251:12200` 같은 기본값을 직접 들고 있지 않는다.
- 테스트 fixture 와 문서 예시는 일부 남아 있을 수 있지만, runtime 설정 원본은 compose 다.
