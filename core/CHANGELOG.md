# Changelog — @zanbug/js

## 2.0.2 — 2026-11-17

- **Circuit breaker**: Zanbug serveri əlçatmaz olanda (söndürülüb, ödəniş, şəbəkə) SDK artıq hər göndərişdə 8 san timeout gözləmir. Uğursuz göndərişdən (şəbəkə xətası, timeout, 5xx) sonra 30 san (təkrar uğursuzluqda 60, 120 … maks. 10 dəq) göndərişlər dərhal atlanır, sonra yalnız 1 "probe" buraxılır; uğurlu olsa breaker bağlanır. 4xx serverin sağ olduğunu bildirir, breaker-ə təsir etmir. Vəziyyət host üzrə, prosesdə paylaşılır. Əvvəl: ölü serverdə soketlər/taymerlər yığılır, flush-ı `await` edən serverless handler-lər gecikirdi.

## 2.0.0 — 2026-10-07

- `2.0.0` — paket `@zanbug/*` adına keçdi; env `ZANBUG_*`; köhnə env adları fallback kimi oxunur (Node), `window.Zanbug`, `X-Zanbug-Key`, `npx zanbug`, standalone `zanbug.global.js`.
