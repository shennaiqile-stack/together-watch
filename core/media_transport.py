"""Bounded CDN connection attempts; byte ranges are never replaced by a full download."""
import time
import urllib.error
import urllib.request


def open_media(candidates, headers, context, budget=10, connect_timeout=3):
    deadline = time.monotonic() + budget
    last_error = None
    for candidate in candidates:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            response = urllib.request.urlopen(
                urllib.request.Request(candidate, headers=headers),
                timeout=min(connect_timeout, remaining), context=context)
            # Header acquisition should fail over quickly; a playing stream
            # needs a separate read timeout for brief throughput fluctuations.
            try:
                response.fp.raw._sock.settimeout(15)
            except (AttributeError, OSError):
                pass
            return response
        except (urllib.error.URLError, OSError) as error:
            if isinstance(error, urllib.error.HTTPError):
                if error.code == 416:
                    raise
                error.close()
            last_error = error
    if last_error is not None:
        raise last_error
    raise TimeoutError('视频线路连接超时，请重试')
