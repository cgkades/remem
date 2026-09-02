---
title: OAuth callback failure
aliases: callback incident
tags: oauth, failure
type: episodic
freshness: current
summary: Prior authentication failure and fix
---

# OAuth callback failure

The callback failed because the proxy stripped the forwarded host header.

The fix was to preserve Forwarded and X-Forwarded-Host.
