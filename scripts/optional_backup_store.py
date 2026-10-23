"""Compatibility import; implementation lives in backend.services.system."""
import sys
from backend.services.system import backup_store as _implementation
sys.modules[__name__] = _implementation
