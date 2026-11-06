# Leaderboards: simplify before the next UI build

Status: visual planning. The current implementation is a functional draft, not an approved visual target.
User direction: plan with images first; current page is too dense for simple information.

## Job

See which traders or copiers are doing well, compare return percentage with net dollar profit,
and narrow the list to people I follow. Following is free and separate from a Copy Pass.

## Content hierarchy

1. Leaderboards title and a quiet trader/copier switch.
2. Everyone / Following text tabs, with a compact sort menu on the same line.
3. One list: rank, avatar + name, percentage return, dollar profit.
4. Follow action appears on the row; profile details open on demand.

Move wallet addresses, closed-position counts, methodology, following management,
and comparison-to-the-other-sort arrows out of the default list.
Use one small `?` for methodology. Remove the right-hand Following panel.
Keep both profit figures visible; the selected sort receives slightly stronger emphasis.
No charts, podiums, rank-change badges, nested cards, or promotional explanations.

## Image concepts to compare

### People first (recommended)

A single airy list with five or six people, readable names and small avatars.
Two aligned profit figures to the right. Underlined trader/copier tabs; Everyone/Following
under the heading. A small sort dropdown avoids a third segmented control.
Desktop width around 840 px inside the existing app shell, generous whitespace.
Follow is a quiet plus/check action at the far right.

### Numbers first

A compact unboxed ranking list: rank + name left; net profit large right,
with percentage directly beneath it. Switching the sort flips which figure is emphasized.
Less column structure; both figures remain visible. Small profile action on each row.

### Your circle

Following opens by default for returning users who follow someone; Everyone for new users.
The same simple list, a compact trader/copier menu, and a subtle Following/Everyone tab bar.
One short empty-state action leads to Everyone. No separate follow-management panel.

## Visual constraints for all three images

- Desktop concept: 1440 × 1024. Maintain Swipr's warm off-white background, dark ink,
  DM Sans/Manrope typography, coral accent and green positive profit.
- All required controls stay visible without competing pill groups.
- Mock people and profits must be marked as sample data; no invented live verification.
- Mobile keeps the same four content groups and both figures; secondary details stay on demand.
- Use the existing screenshot and original research visual guide as grounding.
- Date anchor: 6 November 2026; avoid unnecessary dates or time controls.

## Before implementation

- [x] Document why the current draft is dense and the simpler information hierarchy.
- [x] Render three separate static image mockups locally from the existing visual language.
- [ ] Review the images with the user and select a direction.
- [ ] Apply the chosen direction, then verify desktop and mobile spacing and interactions.

The user selected regular mockups without an API. The local Pillow renderer is
`design/leaderboards/render_mockups.py`; it uses existing project fonts and sample avatars.
Run `uv run --with pillow python design/leaderboards/render_mockups.py` to reproduce:

- `.context/leaderboards/01-people-first.png`
- `.context/leaderboards/02-numbers-first.png`
- `.context/leaderboards/03-your-circle.png`

These are static image studies with illustrative figures; the running app is unchanged.
PNG previews live in the gitignored `.context` directory; the renderer and brief are committed.
No redesign implementation is authorized by selecting this document alone.
