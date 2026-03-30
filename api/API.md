# Steel Browser API

이 문서는 Steel API가 포트 `12200`에서 노출하는 브라우저 제어/보기 인터페이스를 설명합니다.

세션 생성과 일반 브라우저 동작은 HTTP로 처리하고, 실시간 화면 보기와 탭 제어는 WebSocket으로 처리합니다.

## 기본 URL

```text
http://127.0.0.1:12200
```

배포 환경에서 호스트나 포트가 다르면 그 값으로 바꿔서 쓰면 됩니다.

## 빠른 흐름

1. `POST /v1/sessions`로 세션을 생성합니다.
2. `GET /v1/sessions/:id/live-details`를 호출해 `pages[].id`를 고릅니다.
3. `WS /v1/sessions/cast?pageId=<PAGE_ID>`에 연결해 실시간 프레임을 받습니다.
4. 같은 WebSocket으로 JSON 제어 이벤트를 보내 페이지를 조작합니다.
5. `POST /v1/sessions/:sessionId/release`로 세션을 해제합니다.

## HTTP 엔드포인트

### `POST /v1/sessions`
브라우저 세션을 생성합니다.

자주 쓰는 필드:

- `dimensions`: `{ "width": 1356, "height": 763 }`
- `proxyUrl`
- `userAgent`
- `persist`
- `headless`
- `sessionContext`

예시:

```bash
curl -X POST http://127.0.0.1:12200/v1/sessions \
  -H 'Content-Type: application/json' \
  -d '{"dimensions":{"width":1356,"height":763}}'
```

### `GET /v1/sessions/:id/live-details`
현재 브라우저 상태를 반환합니다.

중요한 응답 필드:

- `pages[]`: 현재 열려 있는 탭/페이지
- `pages[].id`: WebSocket cast 연결의 `pageId`로 사용
- `pages[].url`, `pages[].title`, `pages[].favicon`
- `browserState.initialDimensions`
- `browserState.pageCount`
- `websocketUrl`, `sessionViewerUrl`

예시:

```bash
curl http://127.0.0.1:12200/v1/sessions/<SESSION_ID>/live-details
```

### `GET /v1/sessions/debug`
cast WebSocket을 감싼 HTML 라이브 뷰어를 반환합니다.

유용한 쿼리 파라미터:

- `pageId=<PAGE_ID>`: 특정 페이지를 엽니다
- `pageIndex=<N>`: 인덱스로 페이지를 지정합니다
- `showControls=false`: 뷰어 컨트롤을 숨깁니다

이 엔드포인트는 브라우저 UI용이고, 실제 프레임/제어 프로토콜은 cast WebSocket입니다.

### `POST /v1/sessions/:sessionId/release`
현재 활성 세션을 종료합니다.

### 세션 범위 캡처 보조 API

아래 엔드포인트는 현재 세션 페이지에서 동작합니다.

- `POST /v1/sessions/scrape`
- `POST /v1/sessions/screenshot`
- `POST /v1/sessions/pdf`

이들은 폴링 방식 캡처에 유용하지만, 실시간 cast WebSocket과는 별개입니다.

## WebSocket 라이브 뷰

### `WS /v1/sessions/cast?pageId=<PAGE_ID>`

한 페이지/탭의 라이브 화면 채널입니다.

연결된 각 소켓은 정확히 하나의 `pageId`만 제어합니다.

### 수신 메시지

#### 프레임 payload

```json
{
  "pageId": "...",
  "url": "https://example.com",
  "title": "Example Domain",
  "favicon": "https://example.com/favicon.ico",
  "data": "<base64-encoded jpeg>"
}
```

`data`는 base64로 인코딩된 JPEG 이미지입니다. 디코딩해서 렌더링하거나 저장하면 됩니다.

#### 탐색(discovery) 메시지

`pageId` 없이 연결하면 다음과 같은 탭 탐색 메시지가 올 수 있습니다.

- `tabList`
- `tabClosed`

## 송신 제어 메시지

같은 WebSocket으로 JSON 객체를 보내면 됩니다.

### 마우스

```json
{
  "type": "mouseEvent",
  "pageId": "...",
  "event": {
    "type": "mousePressed",
    "x": 120,
    "y": 80,
    "button": "left",
    "modifiers": 0,
    "clickCount": 1
  }
}
```

### 키보드

```json
{
  "type": "keyEvent",
  "pageId": "...",
  "event": {
    "type": "keyDown",
    "code": "Enter",
    "key": "Enter",
    "keyCode": 13,
    "text": "\n"
  }
}
```

### 이동

```json
{
  "type": "navigation",
  "pageId": "...",
  "event": {
    "url": "https://www.google.com"
  }
}
```

### 그 외 지원 이벤트

- `closeTab`
- `getSelectedText`

## 실무 메모

- `pageId`는 브라우저 프로세스 단위가 아니라 탭/페이지 단위입니다.
- 라이브 화면이 필요하면 cast WebSocket을 쓰고, 한 장의 스냅샷이면 screenshot 엔드포인트를 쓰면 됩니다.
- 현재 배포 기준 예시 포트는 `12200`이다.
