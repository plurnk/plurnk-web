# Plurnk Web Agent Guidance

Read `../POSSUMTECH.md` before working in this repository. Stop if it is
unavailable.

This repository owns the open-source browser client for PLURNK: its browser
application and foreground loopback portal loaded by `plurnk web`. Preserve the
client boundary. It consumes `plurnk-service` exclusively through public AG-UI+
and must not absorb daemon, provider, persistence, configuration-cascade, or
enterprise control-plane responsibilities.

The terminal client resolves the ordinary client configuration and loads this
module, but neither client owns the other's presentation. Share only
presentation-neutral AG-UI session behavior whose contract is genuinely
common.
