# Provider verification — live results

Run at: 2026-08-13T00:36:15.671105+00:00

## OddsPapi

**Errors during probing:**
- 1xbet: odds-by-tournaments call failed — GET https://api.oddspapi.io/v4/odds-by-tournaments?bookmaker=1xbet&tournamentIds=17&apiKey=[REDACTED] -> HTTP 429: {"error":{"message":"You are being rate limited. Please wait before making more requests to this endpoint.","code":"RATE_LIMITED","details":"Please wait 0.59 seconds before making another request to /v4/odds-by-tournaments.","retryAfter":"0.59 seconds","retryMs":588}}

- Football sport found: True
- Tournament catalog size (this sport): 1762
- Probed tournament: Premier League (id=17)
- Full bookmaker catalog size: 350
- Catalog lists Pinnacle: True
- Catalog lists 1xBet: True
- `odds-by-tournaments` for `pinnacle`: {'fixtures_returned': 10, 'fixtures_with_priced_odds': 10}
- `odds-by-tournaments` for `1xbet`: {'error': 'GET https://api.oddspapi.io/v4/odds-by-tournaments?bookmaker=1xbet&tournamentIds=17&apiKey=[REDACTED] -> HTTP 429: {"error":{"message":"You are being rate limited. Please wait before making more requests to this endpoint.","code":"RATE_LIMITED","details":"Please wait 0.59 seconds before making another request to /v4/odds-by-tournaments.","retryAfter":"0.59 seconds","retryMs":588}}'}
- Rate-limit-looking response headers: {}

## API-Football

- Account status: {"subscription": {"plan": "Free", "end": "2027-08-13T00:00:00+00:00", "active": true}, "requests": {"current": 0, "limit_day": 100}}
- Fixtures returned for 2026-08-16: 0
- Rate-limit-looking response headers: {}

## Decision

- **Pinnacle coverage on OddsPapi confirmed live: True.** Proceed with OddsPapi as the sharp reference.