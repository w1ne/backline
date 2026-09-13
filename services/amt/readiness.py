"""Readiness for /health: a pod whose model is still loading (or failed to load) is not healthy.

The relay maps a 503 here to `amtState: "loading"` and `amt: false`, so the deploy script waits,
the watchdog leaves a loading pod alone, and a pod whose download failed stops reporting healthy.
"""


def health_response(model_loaded, load_error, model, device, sampler):
    """(status_code, body) for GET /health."""
    body = {"model": model, "device": device, "sampler": sampler}
    if model_loaded:
        return 200, {"status": "ok", **body}
    if load_error is not None:
        return 503, {"status": "error", "error": str(load_error), **body}
    return 503, {"status": "loading", **body}
