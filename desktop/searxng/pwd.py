"""Windows shim for the Unix-only stdlib module `pwd`.

⚠️ THIS FILE IS WHY SEARXNG RUNS ON WINDOWS AT ALL.

SearXNG officially supports Linux only, and `searx/valkeydb.py` imports `pwd` unconditionally at
module load. The chain is not optional: webapp.py -> limiter -> valkeydb -> `import pwd`. On Windows
that raises ModuleNotFoundError before the server ever starts, so a stock SearXNG cannot boot there.

It is used for exactly one thing — looking up the current user's home directory to build a default
Valkey socket path — and we run without Valkey, so the value is never consumed.

Deliberately shipped as a module in OUR bundle directory (which precedes site-packages on
PYTHONPATH) rather than as a patch to SearXNG: upstream stays pristine, so updating SearXNG remains
a plain tarball swap with nothing to re-apply. Harmless on macOS/Linux, where the real `pwd` is a
builtin and wins over anything on the path.
"""

import os


class struct_passwd(tuple):
    def __new__(cls, seq):
        return super().__new__(cls, seq)

    pw_name = property(lambda s: s[0])
    pw_passwd = property(lambda s: s[1])
    pw_uid = property(lambda s: s[2])
    pw_gid = property(lambda s: s[3])
    pw_gecos = property(lambda s: s[4])
    pw_dir = property(lambda s: s[5])
    pw_shell = property(lambda s: s[6])


def getpwuid(_uid=0):
    return struct_passwd(
        (os.environ.get("USERNAME", "vds"), "x", 0, 0, "", os.path.expanduser("~"), "")
    )


def getpwnam(_name):
    return getpwuid(0)
