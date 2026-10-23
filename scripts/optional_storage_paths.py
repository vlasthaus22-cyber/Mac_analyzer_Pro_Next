"""Compatibility import; implementation lives in backend.services.system."""
import sys
from backend.services.system import storage_paths as _implementation
sys.modules[__name__] = _implementation
