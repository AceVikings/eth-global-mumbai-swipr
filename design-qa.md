# Leaderboard design QA

Source: selected People first study, `.context/leaderboards/01-people-first.png`
(logical 1440 x 1024, rendered at 2x).
Implementation: `http://localhost:5173/#leaderboards`.

The selected structure is implemented: quiet role/scope tabs, compact sort, rank/person,
return and net profit, follow action, secondary details on demand. Historical mobile
preview evidence exists at `.context/leaderboards/mobile-implemented.png`.

The latest user requirement removes runtime sample data. There are no verified closed
positions configured, so the app renders an unavailable state. A populated screenshot in
the same state as the source cannot be captured without real history. Native Chrome
inspection also returned `noWindowsAvailable`; browser access host inventory was unavailable.
No new populated screenshot or source/implementation comparison was completed in this pass.
Historical preview screenshots are not live-data or full visual-acceptance evidence.

Pending: compare fonts, spacing, colors, actual profile content and portraits at matching
1440 x 1024 and mobile viewports; verify profile-dialog focus/Escape, percentage/dollar sort,
role switching and Following with real accounts. Preserve both profit figures and avoid
restoring fixtures to pass this gate.

final result: blocked
