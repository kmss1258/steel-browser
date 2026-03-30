# 설치 가이드

이 문서는 새 PC에서 아래 3개 레포를 처음 세팅하는 가장 간단한 절차만 정리한다.

- `steel-browser`
- `steel-browser-control-plane`
- `steel-browser-front`

기준 OS는 Linux/macOS 계열 쉘이다.

## 1. 준비물

먼저 아래가 설치돼 있어야 한다.

- Git
- Docker / Docker Compose
- Node.js 20+
- Python 3.11+

## 2. 작업 폴더 만들기

```bash
mkdir -p ~/workspace
cd ~/workspace
```

## 3. 레포 clone

```bash
git clone git@github.com:kmss1258/steel-browser.git
git clone git@github.com:kmss1258/steel-browser-control-plane.git
git clone git@github.com:kmss1258/steel-browser-front.git
```

예시 최종 구조:

```text
~/workspace/
  steel-browser/
  steel-browser-control-plane/
  steel-browser-front/
```

## 4. Steel Browser 실행

가장 먼저 브라우저 런타임을 띄운다.

기본 `docker-compose.yml` 기준으로도 로컬 `api/` 이미지가 build 되므로, plain `docker compose up` 만으로도 현재 API 변경이 반영된다.
현재 기본 compose 설정 기준 fresh session 기본값은 다음과 같다.

- `headless=true`
- `dimensions=1356x763`

```bash
cd ~/workspace/steel-browser
docker compose up -d --build
```

headful 로 띄워야 하면 명시적으로 override 한다.

```bash
cd ~/workspace/steel-browser
CHROME_HEADLESS=false docker compose up -d --build
```

UI까지 로컬 소스로 함께 build 해야 하면 dev compose 를 사용한다.

```bash
cd ~/workspace/steel-browser
docker compose -f docker-compose.dev.yml up -d --build
```

정상 확인:

```bash
curl http://192.168.50.251:12200/v1/sessions
```

응답이 오면 다음 단계로 진행한다.

## 5. Control Plane 실행

`steel-browser-control-plane`은 프로젝트 폴더 안에서 `docker compose up`으로 바로 띄운다.

```bash
cd ~/workspace/steel-browser-control-plane
STEEL_API_BASE_URL="http://192.168.50.251:12200" \
CONTROL_PLANE_CORS_ALLOW_ORIGINS="http://127.0.0.1:12300,http://localhost:12300,http://192.168.50.251:12300" \
docker compose up -d --build
```

정상 확인:

```bash
curl http://192.168.50.251:12210/health
```

로그 확인:

```bash
cd ~/workspace/steel-browser-control-plane
docker compose logs -f
```

## 6. Frontend 실행

Frontend는 Docker로 가장 간단히 띄운다.

```bash
cd ~/workspace/steel-browser-front
NEXT_PUBLIC_STEEL_API_BASE_URL="http://192.168.50.251:12200" \
NEXT_PUBLIC_CONTROL_PLANE_BASE_URL="http://192.168.50.251:12210" \
NEXT_PUBLIC_STEEL_API_PORT="12200" \
NEXT_PUBLIC_CONTROL_PLANE_PORT="12210" \
STEEL_API_BASE_URL="http://host.docker.internal:12200" \
docker compose up -d --build admin-frontend
```

정상 확인:

```bash
curl -I http://192.168.50.251:12300
```

## 7. 브라우저 접속

웹 브라우저에서 아래 주소로 접속한다.

```text
http://192.168.50.251:12300
```

## 8. 최초 접속 후 확인할 값

상단 입력값이 아래와 같아야 한다.

- Steel API: `http://192.168.50.251:12200`
- Control Plane: `http://192.168.50.251:12210`

만약 예전 값(`127.0.0.1`, 다른 포트 등)이 남아 있으면 브라우저 localStorage/cookie 때문에 꼬일 수 있다.
그럴 때는 브라우저 저장 데이터를 지우고 다시 접속한다.

## 9. 문제 생기면 확인 순서

1. Steel 살아 있는지 확인

```bash
curl http://192.168.50.251:12200/v1/sessions
```

2. Control Plane 살아 있는지 확인

```bash
curl http://192.168.50.251:12210/health
```

필요하면 로그도 확인

```bash
cd ~/workspace/steel-browser-control-plane
docker compose logs -f
```

3. Frontend 열리는지 확인

```bash
curl -I http://192.168.50.251:12300
```

## 10. 요약

실행 순서는 항상 아래다.

1. `steel-browser`
2. `steel-browser-control-plane`
3. `steel-browser-front`

접속 주소는 최종적으로:

```text
http://192.168.50.251:12300
```
