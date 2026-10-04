# Changelog

## 0.4.0 — 2026-10-04

- Renamed the project to **Cinnamon Music Pill**.
- Added a stable public UUID: `cinnamon-music-pill@ammar`.
- Preserved the lightweight MPRIS/D-Bus architecture.
- Play/Pause updates the existing icon and status immediately, then confirms the real player state asynchronously.
- Previous/Next use asynchronous MPRIS calls.
- Added custom widget scale from 60% to 200%.
- Added manual fixed-height control from 0–600 px; 0 means automatic height.
- Added configurable background opacity from 20% to 100%.
- Removed the outer border and focus/box-shadow artifacts.
- Added fixed album-art containers to prevent artwork from changing the layout unexpectedly.
- Added title/artist/album ellipsis handling.

## 0.3.x

- Initial MPRIS music desklet implementation and iterative UI/performance fixes.
