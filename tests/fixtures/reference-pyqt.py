# -*- coding: utf-8 -*-
"""
MAC Analyzer Pro - FULL EDITION 9.0
РАСШИРЕННОЕ ОПРЕДЕЛЕНИЕ ПРОИЗВОДИТЕЛЯ И МОДЕЛИ ПО MAC-АДРЕСУ
+ ИСТОРИЯ ПРОИЗВОДИТЕЛЕЙ И МОДЕЛЕЙ
+ ДВА РЕЖИМА РАБОТЫ
+ ДЕТАЛЬНАЯ ИСТОРИЯ MAC-АДРЕСА
+ ПОИСК ПО МОДЕЛЯМ С ВЫВОДОМ ВСЕХ ПРЕФИКСОВ
+ ПОДСВЕТКА АКТИВНЫХ КНОПОК
+ ЭКСПОРТ РЕЗУЛЬТАТОВ (7+ ФОРМАТОВ)
+ АНАЛИТИКА ПО УСТРОЙСТВАМ
+ ИСТОРИЯ ИЗМЕНЕНИЙ ПО ДАТАМ
"""

import re
import pandas as pd
import numpy as np
import json
import time
import os
import sys
import csv
import logging
import sqlite3
import smtplib
import signal
import gc
import hashlib
import shutil
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from collections import defaultdict, Counter
from datetime import datetime, timedelta
from pathlib import Path
from functools import lru_cache, wraps
from contextlib import contextmanager
from typing import Dict, List, Tuple, Optional, Any, Callable
import warnings
import matplotlib
matplotlib.use('Qt5Agg')
import matplotlib.pyplot as plt
from matplotlib.backends.backend_qt5agg import FigureCanvasQTAgg
from matplotlib.backends.backend_qt5agg import NavigationToolbar2QT as NavigationToolbar
warnings.filterwarnings('ignore')

from PyQt5.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, QPushButton,
    QLabel, QFileDialog, QMessageBox, QProgressBar, QTextEdit, QComboBox,
    QLineEdit, QCheckBox, QGroupBox, QTabWidget, QTableWidget, QTableWidgetItem,
    QHeaderView, QDialog, QDialogButtonBox, QListWidget, QListWidgetItem,
    QSplashScreen, QInputDialog, QRadioButton, QSlider, QFormLayout, QSplitter,
    QMenu, QStatusBar, QShortcut, QScrollArea, QProgressDialog, QSpinBox,
    QToolButton, QToolBar, QAction, QStackedWidget, QFrame, QApplication as QApp,
    QTreeWidget, QTreeWidgetItem, QDateEdit
)
from PyQt5.QtCore import Qt, QThread, pyqtSignal, QTimer, QByteArray, QSize, QPoint, QObject, QMutex, QMutexLocker, QDate
from PyQt5.QtGui import QPixmap, QFont, QColor, QPainter, QPen, QKeySequence
from PyQt5.QtCore import QUrl
from PyQt5.QtGui import QDesktopServices

# ==================== ПРОВЕРКА ДОПОЛНИТЕЛЬНЫХ БИБЛИОТЕК ====================

try:
    import requests
    REQUESTS_AVAILABLE = True
except ImportError:
    REQUESTS_AVAILABLE = False

try:
    from sklearn.cluster import KMeans
    from sklearn.preprocessing import StandardScaler
    SKLEARN_AVAILABLE = True
except ImportError:
    SKLEARN_AVAILABLE = False

try:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import landscape, A4
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, PageBreak
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import inch
    PDF_AVAILABLE = True
except ImportError:
    PDF_AVAILABLE = False

try:
    import networkx as nx
    NETWORKX_AVAILABLE = True
except ImportError:
    NETWORKX_AVAILABLE = False

try:
    import yaml
    YAML_AVAILABLE = True
except ImportError:
    YAML_AVAILABLE = False

try:
    import psutil
    PSUTIL_AVAILABLE = True
except ImportError:
    PSUTIL_AVAILABLE = False

# ==================== НАСТРОЙКА ЛОГГИРОВАНИЯ ====================

def setup_logging():
    from logging.handlers import RotatingFileHandler
    
    log_formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
    
    file_handler = RotatingFileHandler(
        'mac_analyzer.log',
        maxBytes=10*1024*1024,
        backupCount=5,
        encoding='utf-8'
    )
    file_handler.setFormatter(log_formatter)
    
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(log_formatter)
    
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO)
    root_logger.addHandler(file_handler)
    root_logger.addHandler(console_handler)


setup_logging()


# ==================== ДЕКОРАТОРЫ И УТИЛИТЫ ====================

@contextmanager
def measure_time(operation_name: str):
    start = time.time()
    yield
    elapsed = time.time() - start
    logging.info(f"{operation_name} занял {elapsed:.2f} секунд")


def cached(maxsize: int = 128):
    def decorator(func):
        cache = {}
        
        @wraps(func)
        def wrapper(*args, **kwargs):
            key = hashlib.md5(str(args).encode() + str(kwargs).encode()).hexdigest()
            if key in cache:
                return cache[key]
            result = func(*args, **kwargs)
            if len(cache) >= maxsize:
                cache.pop(next(iter(cache)))
            cache[key] = result
            return result
        return wrapper
    return decorator


class CancellableWorker(QThread):
    progress = pyqtSignal(int, int)
    status = pyqtSignal(str)
    finished = pyqtSignal(object)
    error = pyqtSignal(str)
    
    def __init__(self):
        super().__init__()
        self._is_cancelled = False
        self._mutex = QMutex()
    
    def cancel(self):
        with QMutexLocker(self._mutex):
            self._is_cancelled = True
    
    def is_cancelled(self) -> bool:
        with QMutexLocker(self._mutex):
            return self._is_cancelled


# ==================== МОНИТОР ПАМЯТИ ====================

class MemoryMonitor:
    def __init__(self, threshold_mb=1000):
        self.threshold_mb = threshold_mb
        self.last_check = time.time()
    
    def check_memory(self):
        if not PSUTIL_AVAILABLE:
            return True
        try:
            process = psutil.Process()
            memory_mb = process.memory_info().rss / 1024 / 1024
            
            if memory_mb > self.threshold_mb:
                logging.warning(f"Высокое использование памяти: {memory_mb:.1f} MB")
                return False
            return True
        except:
            return True
    
    def optimize_if_needed(self):
        if not self.check_memory():
            gc.collect()
            return True
        return False


# ==================== КЭШ API ====================

class APICache:
    def __init__(self, cache_file="api_cache.json", max_age_days=30):
        self.cache_file = cache_file
        self.max_age = timedelta(days=max_age_days)
        self.cache = self.load_cache()
    
    def load_cache(self) -> dict:
        if os.path.exists(self.cache_file):
            try:
                with open(self.cache_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    now = datetime.now()
                    return {k: v for k, v in data.items() 
                           if datetime.fromisoformat(v['timestamp']) > now - self.max_age}
            except:
                pass
        return {}
    
    def save_cache(self):
        try:
            with open(self.cache_file, 'w', encoding='utf-8') as f:
                json.dump(self.cache, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logging.error(f"Ошибка сохранения кэша: {e}")
    
    def get(self, key: str) -> Optional[str]:
        if key in self.cache:
            entry = self.cache[key]
            if datetime.fromisoformat(entry['timestamp']) > datetime.now() - self.max_age:
                return entry['value']
            else:
                del self.cache[key]
        return None
    
    def set(self, key: str, value: str):
        self.cache[key] = {
            'value': value,
            'timestamp': datetime.now().isoformat()
        }
        self.save_cache()


# ==================== ВАЛИДАТОР MAC-АДРЕСОВ ====================

class MACValidator:
    PATTERNS = {
        'cisco': r'^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$',
        'standard': r'^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$',
        'plain': r'^[0-9A-Fa-f]{12}$',
        'compact': r'^[0-9A-Fa-f]{10,12}$',
        'dotted': r'^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$'
    }
    
    @classmethod
    def normalize(cls, mac: str) -> Optional[str]:
        if not mac or pd.isna(mac):
            return None
        
        mac_str = str(mac).strip().upper()
        
        clean = re.sub(r'[^0-9A-F]', '', mac_str)
        
        if len(clean) == 10:
            clean = '00' + clean
        elif len(clean) == 11:
            clean = '0' + clean
        elif len(clean) == 8:
            clean = '0000' + clean
        
        if len(clean) == 12:
            return clean
        return None
    
    @classmethod
    def format_mac(cls, mac: str, format_type: str = 'standard') -> str:
        if not mac or len(mac) != 12:
            return mac
        
        if format_type == 'standard':
            return f"{mac[:2]}:{mac[2:4]}:{mac[4:6]}:{mac[6:8]}:{mac[8:10]}:{mac[10:]}"
        elif format_type == 'cisco':
            return f"{mac[:4]}.{mac[4:8]}.{mac[8:12]}"
        elif format_type == 'plain':
            return mac
        elif format_type == 'compact':
            return mac.lstrip('0') or '0'
        return mac


# ==================== ТЕМЫ ОФОРМЛЕНИЯ (БЕЗ ЦВЕТНЫХ КНОПОК) ====================

THEMES = {
    'dark': {
        'name': 'Темная',
        'styles': """
            QMainWindow, QWidget { background-color: #1e1e1e; }
            QGroupBox { font-weight: bold; border: 1px solid #3c3c3c; border-radius: 6px; margin-top: 10px; padding-top: 8px; background-color: #2d2d2d; color: #e0e0e0; }
            QGroupBox::title { color: #e0e0e0; }
            QPushButton { background-color: #3c3c3c; color: #e0e0e0; border: 1px solid #555555; padding: 8px 16px; border-radius: 4px; font-weight: bold; min-width: 120px; }
            QPushButton:hover { background-color: #4a4a4a; }
            QPushButton:pressed { background-color: #2a2a2a; }
            QTableWidget { background-color: #2d2d2d; alternate-background-color: #383838; color: #e0e0e0; gridline-color: #4a4a4a; }
            QHeaderView::section { background-color: #3c3c3c; color: #e0e0e0; padding: 6px; }
            QTabWidget::pane { background-color: #2d2d2d; border-color: #3c3c3c; }
            QTabBar::tab { background-color: #3c3c3c; color: #e0e0e0; padding: 6px 12px; }
            QTabBar::tab:selected { background-color: #4a4a4a; }
            QLineEdit, QComboBox, QTextEdit, QSpinBox { background-color: #3c3c3c; color: #e0e0e0; border: 1px solid #555555; padding: 4px; }
            QListWidget { background-color: #3c3c3c; color: #e0e0e0; border: 1px solid #555555; }
            QListWidget::item:selected { background-color: #4a4a4a; }
            QProgressBar { border: 1px solid #555555; text-align: center; color: #e0e0e0; }
            QProgressBar::chunk { background-color: #4a4a4a; }
            QStatusBar { background-color: #2d2d2d; color: #e0e0e0; }
            QScrollBar:vertical { background-color: #2d2d2d; width: 10px; }
            QScrollBar::handle:vertical { background-color: #555555; border-radius: 5px; }
        """
    },
    'light': {
        'name': 'Светлая',
        'styles': """
            QMainWindow, QWidget { background-color: #f5f5f5; }
            QGroupBox { font-weight: bold; border: 1px solid #cccccc; border-radius: 6px; margin-top: 10px; padding-top: 8px; background-color: #ffffff; color: #333333; }
            QGroupBox::title { color: #333333; }
            QPushButton { background-color: #e0e0e0; color: #333333; border: 1px solid #cccccc; padding: 8px 16px; border-radius: 4px; font-weight: bold; min-width: 120px; }
            QPushButton:hover { background-color: #d0d0d0; }
            QPushButton:pressed { background-color: #c0c0c0; }
            QTableWidget { background-color: #ffffff; alternate-background-color: #f9f9f9; color: #333333; gridline-color: #dddddd; }
            QHeaderView::section { background-color: #e0e0e0; color: #333333; padding: 6px; }
            QTabWidget::pane { background-color: #ffffff; border-color: #cccccc; }
            QTabBar::tab { background-color: #e0e0e0; color: #333333; padding: 6px 12px; }
            QTabBar::tab:selected { background-color: #d0d0d0; }
            QLineEdit, QComboBox, QTextEdit, QSpinBox { background-color: #ffffff; color: #333333; border: 1px solid #cccccc; padding: 4px; }
            QListWidget { background-color: #ffffff; color: #333333; border: 1px solid #cccccc; }
            QListWidget::item:selected { background-color: #d0d0d0; }
            QProgressBar { border: 1px solid #cccccc; text-align: center; color: #333333; }
            QProgressBar::chunk { background-color: #d0d0d0; }
            QStatusBar { background-color: #e0e0e0; color: #333333; }
        """
    },
    'blue': {
        'name': 'Голубая',
        'styles': """
            QMainWindow, QWidget { background-color: #e8f4f8; }
            QGroupBox { font-weight: bold; border: 1px solid #b8d4e3; border-radius: 6px; margin-top: 10px; padding-top: 8px; background-color: #f0f8fc; color: #1a6b8a; }
            QGroupBox::title { color: #1a6b8a; }
            QPushButton { background-color: #c8e0e8; color: #1a6b8a; border: 1px solid #b0c8d4; padding: 8px 16px; border-radius: 4px; font-weight: bold; min-width: 120px; }
            QPushButton:hover { background-color: #b8d4e0; }
            QPushButton:pressed { background-color: #a8c4d0; }
            QHeaderView::section { background-color: #1a6b8a; color: white; }
            QTabBar::tab:selected { background-color: #1a6b8a; color: white; }
            QProgressBar::chunk { background-color: #1a6b8a; }
        """
    },
    'green': {
        'name': 'Зеленая',
        'styles': """
            QMainWindow, QWidget { background-color: #e8f5e9; }
            QGroupBox { font-weight: bold; border: 1px solid #a5d6a7; border-radius: 6px; margin-top: 10px; padding-top: 8px; background-color: #f1f8e9; color: #2e7d32; }
            QGroupBox::title { color: #2e7d32; }
            QPushButton { background-color: #c8e6c9; color: #2e7d32; border: 1px solid #a5d6a7; padding: 8px 16px; border-radius: 4px; font-weight: bold; min-width: 120px; }
            QPushButton:hover { background-color: #b8dcb8; }
            QPushButton:pressed { background-color: #a8cca8; }
            QHeaderView::section { background-color: #2e7d32; color: white; }
            QTabBar::tab:selected { background-color: #43a047; color: white; }
            QProgressBar::chunk { background-color: #43a047; }
        """
    },
    'purple': {
        'name': 'Фиолетовая',
        'styles': """
            QMainWindow, QWidget { background-color: #f3e5f5; }
            QGroupBox { font-weight: bold; border: 1px solid #ce93d8; border-radius: 6px; margin-top: 10px; padding-top: 8px; background-color: #fce4ec; color: #6a1b9a; }
            QGroupBox::title { color: #6a1b9a; }
            QPushButton { background-color: #e1bee7; color: #6a1b9a; border: 1px solid #ce93d8; padding: 8px 16px; border-radius: 4px; font-weight: bold; min-width: 120px; }
            QPushButton:hover { background-color: #d1aed7; }
            QPushButton:pressed { background-color: #c19ec7; }
            QHeaderView::section { background-color: #6a1b9a; color: white; }
            QTabBar::tab:selected { background-color: #8e24aa; color: white; }
            QProgressBar::chunk { background-color: #8e24aa; }
        """
    },
    'orange': {
        'name': 'Оранжевая',
        'styles': """
            QMainWindow, QWidget { background-color: #fff3e0; }
            QGroupBox { font-weight: bold; border: 1px solid #ffcc80; border-radius: 6px; margin-top: 10px; padding-top: 8px; background-color: #fff8e1; color: #e65100; }
            QGroupBox::title { color: #e65100; }
            QPushButton { background-color: #ffe0b2; color: #e65100; border: 1px solid #ffcc80; padding: 8px 16px; border-radius: 4px; font-weight: bold; min-width: 120px; }
            QPushButton:hover { background-color: #ffcc80; }
            QPushButton:pressed { background-color: #ffb74d; }
            QHeaderView::section { background-color: #e65100; color: white; }
            QTabBar::tab:selected { background-color: #f57c00; color: white; }
            QProgressBar::chunk { background-color: #f57c00; }
        """
    },
    'professional': {
        'name': 'Профессиональная',
        'styles': """
            QMainWindow, QWidget { background-color: #263238; }
            QGroupBox { font-weight: bold; border: 1px solid #455a64; border-radius: 6px; margin-top: 10px; padding-top: 8px; background-color: #37474f; color: #ffab40; }
            QGroupBox::title { color: #ffab40; }
            QPushButton { background-color: #455a64; color: #eceff1; border: 1px solid #607d8b; padding: 8px 16px; border-radius: 4px; font-weight: bold; min-width: 120px; }
            QPushButton:hover { background-color: #546e7a; }
            QPushButton:pressed { background-color: #37474f; }
            QTableWidget { background-color: #2c3e50; color: #ecf0f1; alternate-background-color: #34495e; }
            QHeaderView::section { background-color: #1a252f; color: #ffab40; padding: 6px; }
            QTabBar::tab { background-color: #455a64; color: #eceff1; }
            QTabBar::tab:selected { background-color: #ffa000; color: #263238; }
            QLineEdit, QComboBox, QTextEdit, QSpinBox { background-color: #455a64; color: #eceff1; border: 1px solid #607d8b; padding: 4px; }
            QProgressBar::chunk { background-color: #ffa000; }
        """
    }
}


# ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================

def get_column_letter(index: int) -> str:
    result = ""
    while index >= 0:
        result = chr(65 + (index % 26)) + result
        index = index // 26 - 1
    return result


def get_all_column_letters(max_cols: int = 100) -> list:
    return [get_column_letter(i) for i in range(max_cols)]


def extract_oui(mac: str, oui_length: int = 3) -> str:
    if not mac:
        return None
    clean_mac = re.sub(r'[^0-9A-Fa-f]', '', mac).upper()
    required_chars = oui_length * 2
    if len(clean_mac) >= required_chars:
        return clean_mac[:required_chars]
    return clean_mac if clean_mac else None


def format_oui(oui: str, oui_length: int = 3) -> str:
    if not oui:
        return ""
    parts = []
    for i in range(oui_length):
        start = i * 2
        if start + 2 <= len(oui):
            parts.append(oui[start:start+2])
    return ":".join(parts) if parts else oui


def validate_mac(mac: str) -> bool:
    if not mac or pd.isna(mac):
        return False
    clean = re.sub(r'[^0-9A-Fa-f]', '', str(mac))
    return len(clean) == 12


def validate_ip(ip: str) -> bool:
    if not ip or pd.isna(ip):
        return False
    pattern = r'^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$'
    if re.match(pattern, str(ip)):
        parts = str(ip).split('.')
        return all(0 <= int(p) <= 255 for p in parts)
    return False


def load_vendor_database_from_file(filepath: str = "oui.txt") -> dict:
    vendor_data = {}
    if not os.path.exists(filepath):
        return vendor_data
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            for line in f:
                if '(hex)' in line:
                    parts = line.split('(hex)')
                    if len(parts) >= 2:
                        oui_part = parts[0].strip().replace('-', '')
                        vendor = parts[1].strip()
                        if oui_part and vendor:
                            vendor_data[oui_part] = vendor
    except Exception as e:
        logging.warning(f"Не удалось загрузить внешний oui.txt: {e}")
    return vendor_data


def safe_load_file(filepath: str, max_retries: int = 3) -> Tuple[Optional[pd.DataFrame], Optional[str]]:
    for attempt in range(max_retries):
        try:
            if filepath.endswith('.csv'):
                for encoding in ['utf-8', 'cp1251', 'latin1']:
                    try:
                        df = pd.read_csv(filepath, encoding=encoding, dtype=str)
                        return df, None
                    except UnicodeDecodeError:
                        continue
                return None, "Не удалось определить кодировку файла"
            else:
                df = pd.read_excel(filepath, dtype=str, engine='openpyxl')
                return df, None
        
        except Exception as e:
            if attempt < max_retries - 1:
                time.sleep(1)
                continue
            return None, str(e)
    return None, "Неизвестная ошибка"


# ==================== БАЗА ДАННЫХ ПРОИЗВОДИТЕЛЕЙ ====================

class VendorDatabase:
    BUILTIN_VENDOR_DATA = {
        '00037F': 'Apple Inc.', '001A11': 'Apple Inc.', '18FE34': 'Apple Inc.',
        '001B44': 'Intel Corporation', '00A0C9': 'Intel Corporation',
        'ACDE48': 'Samsung Electronics', '002590': 'Samsung Electronics',
        '001122': 'Cisco Systems', '00055D': 'Cisco Systems',
        '0050B6': 'Dell Inc.', '00155F': 'Hewlett Packard',
        '0050C2': 'Microsoft Corp.', '005A39': 'Google LLC',
        '0025D3': 'Huawei Technologies', '002128': 'Xiaomi Corporation',
        '0022B0': 'TP-Link Technologies', '001E52': 'Netgear Inc.',
        'F832E4': 'ASUSTeK Computer', 'B827EB': 'Raspberry Pi Foundation',
        '002314': 'Lenovo Group', '0022BD': 'Acer Inc.',
        '0024B2': 'LG Electronics', '001E58': 'Sony Corporation',
        '000E58': 'Cisco-Linksys', '001E13': 'Nintendo', '000C29': 'VMware',
        '0050F2': 'Microsoft', '00107B': 'Dell', '001EC9': 'Huawei',
        '0017C8': 'Apple', '00236C': 'Xiaomi', '001AA9': 'Samsung',
    }
    
    MAC5_PREFIX_MODELS = {
        '00112233': 'Cisco Catalyst 2960', '00112244': 'Cisco Catalyst 3560',
        '00112255': 'Cisco Catalyst 3750', '00112266': 'Cisco Catalyst 4500',
        '00112277': 'Cisco Catalyst 6500', '00112288': 'Cisco ASR 1000',
        '00112299': 'Cisco ISR 4000', '005055AA': 'Cisco Nexus 3000',
        '005055BB': 'Cisco Nexus 5000', '005055CC': 'Cisco Nexus 7000',
        '0010B5AA': 'Dell PowerEdge R740', '0010B5BB': 'Dell PowerEdge R640',
        '0010B5CC': 'Dell PowerEdge T340', '0010B5DD': 'Dell OptiPlex 7070',
        '0010B5EE': 'Dell Latitude 5400', '0010B5FF': 'Dell XPS 15',
        '00215AAB': 'HP ProLiant DL380', '00215ACC': 'HP ProLiant DL360',
        '00215ADD': 'HP EliteBook 840', '00215AEE': 'HP ZBook 15',
        '00215AFF': 'HP LaserJet Pro', '00215A11': 'HP OfficeJet Pro',
        '001A1101': 'iPhone 13', '001A1102': 'iPhone 14', '001A1103': 'iPhone 15',
        '001A1120': 'iPad Pro', '001A1121': 'iPad Air', '001A1130': 'MacBook Pro',
        '001A1131': 'MacBook Air', '001A1140': 'iMac 24"', '001A1150': 'Mac Studio',
        '00259001': 'Samsung Galaxy S23', '00259002': 'Samsung Galaxy S22',
        '00259010': 'Samsung Galaxy Tab', '00259020': 'Samsung SSD 980 Pro',
        '00259030': 'Samsung Smart Monitor', '00259040': 'Samsung M7',
        '001EC901': 'Huawei Mate 50', '001EC902': 'Huawei P60',
        '001EC910': 'Huawei MateBook X', '001EC920': 'Huawei Watch GT',
        '00236C01': 'Xiaomi Mi 11', '00236C02': 'Xiaomi 12T',
        '00236C10': 'Xiaomi Mi Band', '00236C20': 'Xiaomi Robot Vacuum',
        '0022B001': 'TP-Link Archer AX73', '0022B002': 'TP-Link Deco X60',
        '0022B010': 'TP-Link Tapo C200', '0022B020': 'TP-Link Kasa KP115',
        '001E5201': 'Netgear Nighthawk RAX200', '001E5202': 'Netgear Orbi RBK852',
        '001E5210': 'Netgear GS308', '001E5220': 'Netgear ReadyNAS',
        'F832E401': 'ASUS ROG Zephyrus', 'F832E402': 'ASUS TUF Gaming',
        'F832E410': 'ASUS RT-AX88U', 'F832E420': 'ASUS ZenBook',
        '00231401': 'Lenovo ThinkPad X1', '00231402': 'Lenovo ThinkPad T14',
        '00231410': 'Lenovo Legion 5', '00231420': 'Lenovo Yoga 9i',
    }
    
    _external_data = None
    _cache_3byte = {}
    _cache_5byte = {}

    @classmethod
    def _get_external_data(cls):
        if cls._external_data is None:
            cls._external_data = load_vendor_database_from_file("oui.txt")
        return cls._external_data

    @classmethod
    @cached(maxsize=1000)
    def get_vendor_by_oui(cls, oui_3byte: str) -> str:
        if not oui_3byte or len(oui_3byte) < 6:
            return 'Unknown'
        
        oui_clean = oui_3byte[:6].upper()
        
        if oui_clean in cls._cache_3byte:
            return cls._cache_3byte[oui_clean]
        
        ext_data = cls._get_external_data()
        
        if oui_clean in ext_data:
            cls._cache_3byte[oui_clean] = ext_data[oui_clean]
            return ext_data[oui_clean]
        
        if oui_clean in cls.BUILTIN_VENDOR_DATA:
            cls._cache_3byte[oui_clean] = cls.BUILTIN_VENDOR_DATA[oui_clean]
            return cls.BUILTIN_VENDOR_DATA[oui_clean]
        
        return 'Unknown'
    
    @classmethod
    def get_model_by_prefix(cls, mac_5byte: str) -> str:
        if not mac_5byte or len(mac_5byte) < 10:
            return None
        
        prefix = mac_5byte[:10].upper()
        
        if prefix in cls.MAC5_PREFIX_MODELS:
            return cls.MAC5_PREFIX_MODELS[prefix]
        
        prefix_8 = prefix[:8]
        for key, model in cls.MAC5_PREFIX_MODELS.items():
            if key.startswith(prefix_8):
                return model
        
        return None
    
    @classmethod
    def get_prefixes_by_model(cls, model_name: str) -> List[Tuple[str, str]]:
        result = []
        for prefix, model in cls.MAC5_PREFIX_MODELS.items():
            if model.lower() == model_name.lower():
                result.append((prefix, model))
            elif model_name.lower() in model.lower():
                result.append((prefix, model))
        return result
    
    @classmethod
    def add_custom_mapping(cls, prefix_5byte: str, model: str):
        if prefix_5byte and model:
            cls.MAC5_PREFIX_MODELS[prefix_5byte.upper()] = model
            return True
        return False


# ==================== РАСШИРЕННАЯ ИСТОРИЯ MAC-АДРЕСОВ ====================

class MACHistoryDatabase:
    def __init__(self, db_path: str = "mac_history.db"):
        self.db_path = db_path
        self.init_db()
    
    def _get_connection(self):
        return sqlite3.connect(self.db_path)
    
    def init_db(self):
        with self._get_connection() as conn:
            conn.execute('''CREATE TABLE IF NOT EXISTS mac_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mac TEXT NOT NULL,
                mac_formatted TEXT,
                oui_3byte TEXT,
                mac_5byte TEXT,
                timestamp TIMESTAMP,
                source_file TEXT,
                vendor TEXT,
                vendor_confidence REAL,
                vendor_source TEXT,
                model TEXT,
                model_confidence REAL,
                model_source TEXT,
                ip TEXT,
                address TEXT,
                room TEXT,
                switch_ip TEXT,
                switch_port TEXT,
                match_details TEXT
            )''')
            
            conn.execute('CREATE INDEX IF NOT EXISTS idx_mac_history_mac ON mac_history(mac)')
            conn.execute('CREATE INDEX IF NOT EXISTS idx_mac_history_timestamp ON mac_history(timestamp)')
            
            conn.execute('''CREATE TABLE IF NOT EXISTS mac_movements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mac TEXT NOT NULL,
                from_value TEXT,
                to_value TEXT,
                field_name TEXT,
                timestamp TIMESTAMP,
                source_file TEXT
            )''')
            
            conn.execute('CREATE INDEX IF NOT EXISTS idx_mac_movements_mac ON mac_movements(mac)')
            conn.commit()
    
    def add_device_record(self, device: dict, source_file: str, timestamp: datetime = None):
        if timestamp is None:
            timestamp = datetime.now()
        
        mac = device.get('mac', '')
        if not mac or len(mac) < 12:
            return False
        
        mac_formatted = MACValidator.format_mac(mac)
        oui_3byte = mac[:6] if len(mac) >= 6 else None
        mac_5byte = mac[:10] if len(mac) >= 10 else None
        
        with self._get_connection() as conn:
            cursor = conn.execute('''SELECT vendor, model, ip, address, room, switch_ip, switch_port
                FROM mac_history WHERE mac = ? ORDER BY timestamp DESC LIMIT 1''', (mac,))
            last_record = cursor.fetchone()
            
            conn.execute('''INSERT INTO mac_history 
                (mac, mac_formatted, oui_3byte, mac_5byte, timestamp, source_file,
                 vendor, vendor_confidence, vendor_source, model, model_confidence, model_source,
                 ip, address, room, switch_ip, switch_port, match_details)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                (mac, mac_formatted, oui_3byte, mac_5byte, timestamp.isoformat(), source_file,
                 device.get('vendor', ''), device.get('vendor_confidence', 0), device.get('vendor_source', ''),
                 device.get('model', ''), device.get('model_confidence', 0), device.get('model_source', ''),
                 device.get('ip', ''), device.get('address', ''), device.get('room', ''),
                 device.get('switch_ip', ''), device.get('switch_port', ''), device.get('match_details', '')))
            
            if last_record:
                fields = ['vendor', 'model', 'ip', 'address', 'room', 'switch_ip', 'switch_port']
                current_values = [
                    device.get('vendor', ''), device.get('model', ''), device.get('ip', ''),
                    device.get('address', ''), device.get('room', ''), device.get('switch_ip', ''),
                    device.get('switch_port', '')
                ]
                
                for i, field in enumerate(fields):
                    old_val = last_record[i] if i < len(last_record) else ''
                    new_val = current_values[i] if i < len(current_values) else ''
                    
                    if old_val != new_val and new_val and new_val not in ['', 'Unknown', 'Не указано']:
                        conn.execute('''INSERT INTO mac_movements 
                            (mac, from_value, to_value, field_name, timestamp, source_file)
                            VALUES (?, ?, ?, ?, ?, ?)''',
                            (mac, old_val or '—', new_val, field, timestamp.isoformat(), source_file))
            
            conn.commit()
        return True
    
    def add_devices_batch(self, devices: List[dict], source_file: str):
        timestamp = datetime.now()
        with self._get_connection() as conn:
            conn.execute('BEGIN TRANSACTION')
            for dev in devices:
                self.add_device_record(dev, source_file, timestamp)
            conn.commit()
    
    def get_mac_history(self, mac: str) -> List[dict]:
        with self._get_connection() as conn:
            cursor = conn.execute('''SELECT timestamp, source_file, vendor, vendor_confidence, vendor_source,
                model, model_confidence, model_source, ip, address, room, switch_ip, switch_port, match_details
                FROM mac_history WHERE mac = ? ORDER BY timestamp ASC''', (mac,))
            rows = cursor.fetchall()
            
            result = []
            for row in rows:
                result.append({
                    'timestamp': row[0], 'source_file': row[1], 'vendor': row[2],
                    'vendor_confidence': row[3], 'vendor_source': row[4], 'model': row[5],
                    'model_confidence': row[6], 'model_source': row[7], 'ip': row[8],
                    'address': row[9], 'room': row[10], 'switch_ip': row[11],
                    'switch_port': row[12], 'match_details': row[13]
                })
            return result
    
    def get_mac_movements(self, mac: str) -> List[dict]:
        with self._get_connection() as conn:
            cursor = conn.execute('''SELECT from_value, to_value, field_name, timestamp, source_file
                FROM mac_movements WHERE mac = ? ORDER BY timestamp ASC''', (mac,))
            rows = cursor.fetchall()
            
            result = []
            for row in rows:
                result.append({
                    'from_value': row[0], 'to_value': row[1], 'field_name': row[2],
                    'timestamp': row[3], 'source_file': row[4]
                })
            return result
    
    def get_mac_last_info(self, mac: str) -> Optional[dict]:
        with self._get_connection() as conn:
            cursor = conn.execute('''SELECT mac_formatted, vendor, model, ip, address, room, switch_ip, switch_port, timestamp
                FROM mac_history WHERE mac = ? ORDER BY timestamp DESC LIMIT 1''', (mac,))
            row = cursor.fetchone()
            if row:
                return {
                    'mac_formatted': row[0], 'vendor': row[1], 'model': row[2],
                    'ip': row[3], 'address': row[4], 'room': row[5],
                    'switch_ip': row[6], 'switch_port': row[7], 'last_seen': row[8]
                }
            return None
    
    def search_by_mac(self, search_term: str) -> List[dict]:
        search_pattern = f"%{search_term.upper()}%"
        with self._get_connection() as conn:
            cursor = conn.execute('''SELECT mac, mac_formatted, MAX(timestamp), vendor, model, ip, address, room, switch_ip, switch_port
                FROM mac_history 
                WHERE mac LIKE ? OR mac_formatted LIKE ?
                GROUP BY mac
                ORDER BY timestamp DESC
                LIMIT 100''', (search_pattern, search_pattern))
            rows = cursor.fetchall()
            
            result = []
            for row in rows:
                result.append({
                    'mac': row[0], 'mac_formatted': row[1], 'last_seen': row[2][:19] if row[2] else '-',
                    'vendor': row[3] if row[3] else '-', 'model': row[4] if row[4] else '-',
                    'ip': row[5] if row[5] else '-', 'address': row[6] if row[6] else '-',
                    'room': row[7] if row[7] else '-', 'switch_ip': row[8] if row[8] else '-',
                    'switch_port': row[9] if row[9] else '-'
                })
            return result
    
    def get_mac_statistics(self, mac: str) -> dict:
        with self._get_connection() as conn:
            cursor = conn.execute('SELECT COUNT(*) FROM mac_history WHERE mac = ?', (mac,))
            total_appearances = cursor.fetchone()[0]
            
            cursor = conn.execute('SELECT MIN(timestamp), MAX(timestamp) FROM mac_history WHERE mac = ?', (mac,))
            first_seen, last_seen = cursor.fetchone()
            
            cursor = conn.execute('SELECT COUNT(DISTINCT source_file) FROM mac_history WHERE mac = ?', (mac,))
            unique_files = cursor.fetchone()[0]
            
            cursor = conn.execute('SELECT COUNT(*) FROM mac_movements WHERE mac = ?', (mac,))
            total_movements = cursor.fetchone()[0]
            
            cursor = conn.execute('SELECT DISTINCT vendor FROM mac_history WHERE mac = ? AND vendor != "" AND vendor != "Unknown"', (mac,))
            vendors = [row[0] for row in cursor.fetchall()]
            
            cursor = conn.execute('SELECT DISTINCT model FROM mac_history WHERE mac = ? AND model != "" AND model != "Unknown"', (mac,))
            models = [row[0] for row in cursor.fetchall()]
            
            return {
                'total_appearances': total_appearances,
                'first_seen': first_seen[:19] if first_seen else '-',
                'last_seen': last_seen[:19] if last_seen else '-',
                'unique_files': unique_files,
                'total_movements': total_movements,
                'vendors': vendors,
                'models': models
            }
    
    def get_all_macs(self, limit: int = 500) -> List[Tuple]:
        with self._get_connection() as conn:
            cursor = conn.execute('''SELECT mac, mac_formatted, MAX(timestamp), vendor, model, ip, address, switch_ip, switch_port
                FROM mac_history GROUP BY mac ORDER BY timestamp DESC LIMIT ?''', (limit,))
            return cursor.fetchall()
    
    def search_all(self, search_term: str) -> List[dict]:
        search_pattern = f"%{search_term}%"
        with self._get_connection() as conn:
            cursor = conn.execute('''SELECT mac, mac_formatted, MAX(timestamp), vendor, model, ip, address, room, switch_ip, switch_port
                FROM mac_history 
                WHERE mac LIKE ? OR mac_formatted LIKE ? OR vendor LIKE ? OR model LIKE ? OR ip LIKE ? OR address LIKE ?
                GROUP BY mac
                ORDER BY timestamp DESC
                LIMIT 200''', 
                (search_pattern, search_pattern, search_pattern, search_pattern, search_pattern, search_pattern))
            rows = cursor.fetchall()
            
            result = []
            for row in rows:
                result.append({
                    'mac': row[0], 'mac_formatted': row[1], 'last_seen': row[2][:19] if row[2] else '-',
                    'vendor': row[3] if row[3] else '-', 'model': row[4] if row[4] else '-',
                    'ip': row[5] if row[5] else '-', 'address': row[6] if row[6] else '-',
                    'room': row[7] if row[7] else '-', 'switch_ip': row[8] if row[8] else '-',
                    'switch_port': row[9] if row[9] else '-'
                })
            return result
    
    def clear_history(self):
        with self._get_connection() as conn:
            conn.execute('DELETE FROM mac_history')
            conn.execute('DELETE FROM mac_movements')
            conn.commit()


# ==================== ДИАЛОГ ИСТОРИИ MAC-АДРЕСА ====================

class MACHistoryDialog(QDialog):
    def __init__(self, mac: str, mac_history_db: MACHistoryDatabase, parent=None):
        super().__init__(parent)
        self.mac = mac
        self.mac_history_db = mac_history_db
        self.mac_formatted = MACValidator.format_mac(mac) if mac else mac
        self.setWindowTitle(f"История MAC-адреса: {self.mac_formatted}")
        self.setModal(True)
        self.setGeometry(100, 100, 1300, 850)
        self.setStyleSheet(parent.styleSheet() if parent else "")
        self.init_ui()
        self.load_data()
    
    def init_ui(self):
        layout = QVBoxLayout()
        
        title = QLabel(f"📋 Детальная история MAC-адреса: {self.mac_formatted}")
        title.setFont(QFont("Segoe UI", 14, QFont.Bold))
        layout.addWidget(title)
        
        # Кнопки
        btn_layout = QHBoxLayout()
        export_btn = QPushButton("📎 Экспортировать историю")
        export_btn.clicked.connect(self.export_history)
        btn_layout.addWidget(export_btn)
        
        analytics_btn = QPushButton("📊 Аналитика устройства")
        analytics_btn.clicked.connect(self.show_analytics)
        btn_layout.addWidget(analytics_btn)
        
        btn_layout.addStretch()
        layout.addLayout(btn_layout)
        
        current_group = QGroupBox("📌 Текущая информация")
        current_layout = QHBoxLayout()
        self.current_info_label = QLabel("Загрузка...")
        self.current_info_label.setWordWrap(True)
        current_layout.addWidget(self.current_info_label)
        current_group.setLayout(current_layout)
        layout.addWidget(current_group)
        
        stats_group = QGroupBox("📊 Статистика")
        stats_layout = QHBoxLayout()
        self.stats_labels = {}
        stats_fields = [
            ('total_appearances', 'Появлений'),
            ('unique_files', 'Файлов'),
            ('total_movements', 'Изменений'),
            ('vendors_count', 'Производителей'),
            ('models_count', 'Моделей')
        ]
        
        for field, label in stats_fields:
            frame = QFrame()
            frame.setFrameShape(QFrame.StyledPanel)
            frame_layout = QVBoxLayout(frame)
            label_widget = QLabel(label)
            label_widget.setStyleSheet("font-size: 10px; color: #888;")
            frame_layout.addWidget(label_widget)
            value_widget = QLabel("0")
            value_widget.setStyleSheet("font-size: 16px; font-weight: bold;")
            frame_layout.addWidget(value_widget)
            stats_layout.addWidget(frame)
            self.stats_labels[field] = value_widget
        
        stats_group.setLayout(stats_layout)
        layout.addWidget(stats_group)
        
        tabs = QTabWidget()
        
        timeline_tab = QWidget()
        timeline_layout = QVBoxLayout(timeline_tab)
        
        self.timeline_table = QTableWidget()
        self.timeline_table.setColumnCount(8)
        self.timeline_table.setHorizontalHeaderLabels(["Дата/Время", "Файл", "Производитель", "Модель", "IP", "Адрес", "Помещение", "Примечание"])
        self.timeline_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        timeline_layout.addWidget(self.timeline_table)
        
        tabs.addTab(timeline_tab, "📅 Хронология")
        
        movements_tab = QWidget()
        movements_layout = QVBoxLayout(movements_tab)
        
        self.movements_table = QTableWidget()
        self.movements_table.setColumnCount(5)
        self.movements_table.setHorizontalHeaderLabels(["Дата/Время", "Поле", "Было", "Стало", "Файл"])
        self.movements_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        movements_layout.addWidget(self.movements_table)
        
        tabs.addTab(movements_tab, "🔄 Изменения")
        
        info_tab = QWidget()
        info_layout = QVBoxLayout(info_tab)
        
        info_text = QTextEdit()
        info_text.setReadOnly(True)
        info_layout.addWidget(info_text)
        self.info_text = info_text
        
        tabs.addTab(info_tab, "ℹ️ Полная информация")
        
        layout.addWidget(tabs)
        
        close_btn = QPushButton("Закрыть")
        close_btn.clicked.connect(self.accept)
        layout.addWidget(close_btn)
        
        self.setLayout(layout)
    
    def show_analytics(self):
        """Показать аналитику по устройству"""
        last_info = self.mac_history_db.get_mac_last_info(self.mac)
        if last_info:
            device = {
                'mac': self.mac,
                'mac_formatted': self.mac_formatted,
                'vendor': last_info.get('vendor', 'Unknown'),
                'model': last_info.get('model', ''),
                'ip': last_info.get('ip', ''),
                'address': last_info.get('address', ''),
                'room': last_info.get('room', ''),
                'switch_ip': last_info.get('switch_ip', ''),
                'switch_port': last_info.get('switch_port', ''),
                'vendor_confidence': 0,
                'model_confidence': 0,
                'vendor_source': 'Из истории',
                'model_source': 'Из истории',
                'match_details': 'Данные из истории'
            }
            
            # Получаем последние данные из истории для уверенности
            history = self.mac_history_db.get_mac_history(self.mac)
            if history:
                last_record = history[-1]
                device['vendor_confidence'] = last_record.get('vendor_confidence', 0)
                device['model_confidence'] = last_record.get('model_confidence', 0)
                device['vendor_source'] = last_record.get('vendor_source', 'Из истории')
                device['model_source'] = last_record.get('model_source', 'Из истории')
            
            dialog = SingleDeviceAnalyticsDialog(self.mac, device, self)
            dialog.exec_()
    
    def export_history(self):
        """Экспорт истории MAC-адреса"""
        history = self.mac_history_db.get_mac_history(self.mac)
        movements = self.mac_history_db.get_mac_movements(self.mac)
        stats = self.mac_history_db.get_mac_statistics(self.mac)
        
        filename, _ = QFileDialog.getSaveFileName(
            self, "Сохранить историю MAC-адреса",
            f"mac_history_{self.mac_formatted.replace(':', '_')}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx",
            "Excel Files (*.xlsx)"
        )
        
        if filename:
            try:
                with pd.ExcelWriter(filename, engine='openpyxl') as writer:
                    # Статистика
                    stats_data = [
                        ['Параметр', 'Значение'],
                        ['MAC-адрес', self.mac_formatted],
                        ['Всего появлений', stats['total_appearances']],
                        ['Первое появление', stats['first_seen']],
                        ['Последнее появление', stats['last_seen']],
                        ['Количество файлов', stats['unique_files']],
                        ['Всего изменений', stats['total_movements']],
                        ['Производители', ', '.join(stats['vendors']) if stats['vendors'] else '-'],
                        ['Модели', ', '.join(stats['models']) if stats['models'] else '-']
                    ]
                    df_stats = pd.DataFrame(stats_data[1:], columns=stats_data[0])
                    df_stats.to_excel(writer, sheet_name='Статистика', index=False)
                    
                    # Хронология
                    if history:
                        history_data = []
                        for record in history:
                            history_data.append({
                                'Дата/Время': record['timestamp'][:19] if record['timestamp'] else '-',
                                'Файл': Path(record['source_file']).name if record['source_file'] else '-',
                                'Производитель': record['vendor'],
                                'Модель': record['model'],
                                'IP-адрес': record['ip'],
                                'Физический адрес': record['address'],
                                'Помещение': record['room'],
                                'IP коммутатора': record['switch_ip'],
                                'Порт': record['switch_port'],
                                'Примечание': record['match_details']
                            })
                        df_history = pd.DataFrame(history_data)
                        df_history.to_excel(writer, sheet_name='Хронология', index=False)
                    
                    # Изменения
                    if movements:
                        movements_data = []
                        field_names = {
                            'vendor': 'Производитель', 'model': 'Модель', 'ip': 'IP-адрес',
                            'address': 'Адрес', 'room': 'Помещение', 'switch_ip': 'IP коммутатора',
                            'switch_port': 'Порт'
                        }
                        for move in movements:
                            movements_data.append({
                                'Дата/Время': move['timestamp'][:19] if move['timestamp'] else '-',
                                'Поле': field_names.get(move['field_name'], move['field_name']),
                                'Было': move['from_value'],
                                'Стало': move['to_value'],
                                'Файл': Path(move['source_file']).name if move['source_file'] else '-'
                            })
                        df_movements = pd.DataFrame(movements_data)
                        df_movements.to_excel(writer, sheet_name='Изменения', index=False)
                
                QMessageBox.information(self, "Успех", f"История MAC-адреса сохранена в:\n{filename}")
            except Exception as e:
                QMessageBox.warning(self, "Ошибка", f"Не удалось сохранить историю: {str(e)}")
    
    def load_data(self):
        last_info = self.mac_history_db.get_mac_last_info(self.mac)
        if last_info:
            current_text = f"""
<b>MAC:</b> {last_info.get('mac_formatted', '-')}<br>
<b>Производитель:</b> {last_info.get('vendor', '-')}<br>
<b>Модель:</b> {last_info.get('model', '-')}<br>
<b>IP-адрес:</b> {last_info.get('ip', '-')}<br>
<b>Физический адрес:</b> {last_info.get('address', '-')}<br>
<b>Помещение:</b> {last_info.get('room', '-')}<br>
<b>IP коммутатора:</b> {last_info.get('switch_ip', '-')}<br>
<b>Порт коммутатора:</b> {last_info.get('switch_port', '-')}<br>
<b>Последнее появление:</b> {last_info.get('last_seen', '-')}
"""
            self.current_info_label.setText(current_text)
        
        stats = self.mac_history_db.get_mac_statistics(self.mac)
        
        self.stats_labels['total_appearances'].setText(str(stats['total_appearances']))
        self.stats_labels['unique_files'].setText(str(stats['unique_files']))
        self.stats_labels['total_movements'].setText(str(stats['total_movements']))
        self.stats_labels['vendors_count'].setText(str(len(stats['vendors'])))
        self.stats_labels['models_count'].setText(str(len(stats['models'])))
        
        history = self.mac_history_db.get_mac_history(self.mac)
        self.timeline_table.setRowCount(len(history))
        for i, record in enumerate(history):
            timestamp = record['timestamp'][:19] if record['timestamp'] else '-'
            self.timeline_table.setItem(i, 0, QTableWidgetItem(timestamp))
            self.timeline_table.setItem(i, 1, QTableWidgetItem(Path(record['source_file']).name if record['source_file'] else '-'))
            self.timeline_table.setItem(i, 2, QTableWidgetItem(record['vendor']))
            self.timeline_table.setItem(i, 3, QTableWidgetItem(record['model']))
            self.timeline_table.setItem(i, 4, QTableWidgetItem(record['ip']))
            self.timeline_table.setItem(i, 5, QTableWidgetItem(record['address']))
            self.timeline_table.setItem(i, 6, QTableWidgetItem(record['room']))
            self.timeline_table.setItem(i, 7, QTableWidgetItem(record['match_details'][:50] if record['match_details'] else '-'))
        
        movements = self.mac_history_db.get_mac_movements(self.mac)
        self.movements_table.setRowCount(len(movements))
        field_names = {
            'vendor': 'Производитель', 'model': 'Модель', 'ip': 'IP-адрес',
            'address': 'Адрес', 'room': 'Помещение', 'switch_ip': 'IP коммутатора',
            'switch_port': 'Порт'
        }
        for i, move in enumerate(movements):
            timestamp = move['timestamp'][:19] if move['timestamp'] else '-'
            self.movements_table.setItem(i, 0, QTableWidgetItem(timestamp))
            self.movements_table.setItem(i, 1, QTableWidgetItem(field_names.get(move['field_name'], move['field_name'])))
            self.movements_table.setItem(i, 2, QTableWidgetItem(move['from_value']))
            self.movements_table.setItem(i, 3, QTableWidgetItem(move['to_value']))
            self.movements_table.setItem(i, 4, QTableWidgetItem(Path(move['source_file']).name if move['source_file'] else '-'))
        
        info_text = f"🔍 ПОЛНАЯ ИНФОРМАЦИЯ О MAC-АДРЕСЕ: {self.mac_formatted}\n\n"
        info_text += "=" * 60 + "\n\n"
        
        info_text += f"📊 СТАТИСТИКА:\n"
        info_text += f"  • Всего появлений в сети: {stats['total_appearances']}\n"
        info_text += f"  • Первое появление: {stats['first_seen']}\n"
        info_text += f"  • Последнее появление: {stats['last_seen']}\n"
        info_text += f"  • В скольких файлах встречается: {stats['unique_files']}\n"
        info_text += f"  • Количество изменений параметров: {stats['total_movements']}\n\n"
        
        if stats['vendors']:
            info_text += f"🏭 ОПРЕДЕЛЕННЫЕ ПРОИЗВОДИТЕЛИ:\n"
            for v in stats['vendors']:
                info_text += f"  • {v}\n"
            info_text += "\n"
        
        if stats['models']:
            info_text += f"📱 ОПРЕДЕЛЕННЫЕ МОДЕЛИ:\n"
            for m in stats['models']:
                info_text += f"  • {m}\n"
            info_text += "\n"
        
        info_text += "=" * 60 + "\n\n"
        info_text += "📅 ХРОНОЛОГИЯ ПОЯВЛЕНИЙ:\n\n"
        
        for i, record in enumerate(history, 1):
            info_text += f"[{i}] {record['timestamp'][:19] if record['timestamp'] else '-'}\n"
            info_text += f"    Файл: {Path(record['source_file']).name if record['source_file'] else '-'}\n"
            info_text += f"    Производитель: {record['vendor']}\n"
            info_text += f"    Модель: {record['model']}\n"
            info_text += f"    IP: {record['ip']}\n"
            info_text += f"    Адрес: {record['address']}\n"
            info_text += f"    Помещение: {record['room']}\n"
            info_text += f"    IP коммутатора: {record['switch_ip']}\n"
            info_text += f"    Порт: {record['switch_port']}\n"
            info_text += f"    Примечание: {record['match_details']}\n"
            info_text += "-" * 40 + "\n"
        
        if movements:
            info_text += "\n" + "=" * 60 + "\n\n"
            info_text += "🔄 ИСТОРИЯ ИЗМЕНЕНИЙ:\n\n"
            for i, move in enumerate(movements, 1):
                info_text += f"[{i}] {move['timestamp'][:19] if move['timestamp'] else '-'}\n"
                info_text += f"    Поле: {field_names.get(move['field_name'], move['field_name'])}\n"
                info_text += f"    Было: {move['from_value']}\n"
                info_text += f"    Стало: {move['to_value']}\n"
                info_text += f"    Файл: {Path(move['source_file']).name if move['source_file'] else '-'}\n"
                info_text += "-" * 40 + "\n"
        
        self.info_text.setText(info_text)


# ==================== ДИАЛОГ АНАЛИТИКИ ПО ОТДЕЛЬНОМУ MAC ====================

class SingleDeviceAnalyticsDialog(QDialog):
    def __init__(self, mac: str, device: dict, parent=None):
        super().__init__(parent)
        self.mac = mac
        self.device = device
        self.setWindowTitle(f"Аналитика устройства: {MACValidator.format_mac(mac) if mac else mac}")
        self.setModal(True)
        self.setGeometry(100, 100, 800, 600)
        self.setStyleSheet(parent.styleSheet() if parent else "")
        self.init_ui()
    
    def init_ui(self):
        layout = QVBoxLayout()
        
        title = QLabel(f"📊 Аналитика устройства")
        title.setFont(QFont("Segoe UI", 16, QFont.Bold))
        layout.addWidget(title)
        
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll_content = QWidget()
        scroll_layout = QVBoxLayout(scroll_content)
        
        # Информация об устройстве
        info_group = QGroupBox("📋 Информация об устройстве")
        info_layout = QFormLayout()
        
        self.mac_label = QLabel(MACValidator.format_mac(self.mac) if self.mac else "-")
        info_layout.addRow("MAC-адрес:", self.mac_label)
        
        self.vendor_label = QLabel(self.device.get('vendor', 'Unknown'))
        info_layout.addRow("Производитель:", self.vendor_label)
        
        self.model_label = QLabel(self.device.get('model', '-'))
        info_layout.addRow("Модель:", self.model_label)
        
        self.ip_label = QLabel(self.device.get('ip', '-'))
        info_layout.addRow("IP-адрес:", self.ip_label)
        
        self.address_label = QLabel(self.device.get('address', '-'))
        info_layout.addRow("Физический адрес:", self.address_label)
        
        self.room_label = QLabel(self.device.get('room', '-'))
        info_layout.addRow("Помещение:", self.room_label)
        
        self.switch_ip_label = QLabel(self.device.get('switch_ip', '-'))
        info_layout.addRow("IP коммутатора:", self.switch_ip_label)
        
        self.switch_port_label = QLabel(self.device.get('switch_port', '-'))
        info_layout.addRow("Порт коммутатора:", self.switch_port_label)
        
        info_group.setLayout(info_layout)
        scroll_layout.addWidget(info_group)
        
        # Уверенность определения
        confidence_group = QGroupBox("🎯 Уверенность определения")
        confidence_layout = QVBoxLayout()
        
        vendor_conf = self.device.get('vendor_confidence', 0)
        model_conf = self.device.get('model_confidence', 0)
        
        self.vendor_confidence_bar = QProgressBar()
        self.vendor_confidence_bar.setRange(0, 100)
        self.vendor_confidence_bar.setValue(int(vendor_conf * 100))
        self.vendor_confidence_bar.setFormat(f"Производитель: {vendor_conf:.0%}")
        confidence_layout.addWidget(self.vendor_confidence_bar)
        
        self.model_confidence_bar = QProgressBar()
        self.model_confidence_bar.setRange(0, 100)
        self.model_confidence_bar.setValue(int(model_conf * 100))
        self.model_confidence_bar.setFormat(f"Модель: {model_conf:.0%}")
        confidence_layout.addWidget(self.model_confidence_bar)
        
        confidence_group.setLayout(confidence_layout)
        scroll_layout.addWidget(confidence_group)
        
        # Источники данных
        sources_group = QGroupBox("📌 Источники данных")
        sources_layout = QVBoxLayout()
        
        vendor_source = self.device.get('vendor_source', 'Не указан')
        model_source = self.device.get('model_source', 'Не указан')
        
        self.vendor_source_label = QLabel(f"Производитель: {vendor_source}")
        self.vendor_source_label.setWordWrap(True)
        sources_layout.addWidget(self.vendor_source_label)
        
        self.model_source_label = QLabel(f"Модель: {model_source}")
        self.model_source_label.setWordWrap(True)
        sources_layout.addWidget(self.model_source_label)
        
        sources_group.setLayout(sources_layout)
        scroll_layout.addWidget(sources_group)
        
        # Детали
        details_group = QGroupBox("📝 Детали")
        details_layout = QVBoxLayout()
        
        self.details_label = QLabel(self.device.get('match_details', 'Нет дополнительной информации'))
        self.details_label.setWordWrap(True)
        details_layout.addWidget(self.details_label)
        
        details_group.setLayout(details_layout)
        scroll_layout.addWidget(details_group)
        
        scroll_layout.addStretch()
        scroll.setWidget(scroll_content)
        layout.addWidget(scroll)
        
        # Кнопки
        btn_layout = QHBoxLayout()
        
        self.export_btn = QPushButton("📎 Экспорт аналитики")
        self.export_btn.clicked.connect(self.export_analytics)
        btn_layout.addWidget(self.export_btn)
        
        close_btn = QPushButton("Закрыть")
        close_btn.clicked.connect(self.accept)
        btn_layout.addWidget(close_btn)
        
        layout.addLayout(btn_layout)
        
        self.setLayout(layout)
    
    def export_analytics(self):
        """Экспорт аналитики устройства"""
        mac_formatted = MACValidator.format_mac(self.mac) if self.mac else "unknown"
        filename, _ = QFileDialog.getSaveFileName(
            self, "Сохранить аналитику устройства",
            f"device_analytics_{mac_formatted}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt",
            "Text Files (*.txt)"
        )
        
        if filename:
            try:
                with open(filename, 'w', encoding='utf-8-sig') as f:
                    f.write("=" * 60 + "\n")
                    f.write(f"АНАЛИТИКА УСТРОЙСТВА\n")
                    f.write(f"Дата: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
                    f.write("=" * 60 + "\n\n")
                    
                    f.write(f"MAC-адрес: {mac_formatted}\n")
                    f.write(f"Производитель: {self.device.get('vendor', 'Unknown')}\n")
                    f.write(f"Модель: {self.device.get('model', '-')}\n")
                    f.write(f"IP-адрес: {self.device.get('ip', '-')}\n")
                    f.write(f"Физический адрес: {self.device.get('address', '-')}\n")
                    f.write(f"Помещение: {self.device.get('room', '-')}\n")
                    f.write(f"IP коммутатора: {self.device.get('switch_ip', '-')}\n")
                    f.write(f"Порт коммутатора: {self.device.get('switch_port', '-')}\n\n")
                    
                    f.write(f"Уверенность определения:\n")
                    f.write(f"  • Производитель: {self.device.get('vendor_confidence', 0):.0%}\n")
                    f.write(f"  • Модель: {self.device.get('model_confidence', 0):.0%}\n\n")
                    
                    f.write(f"Источники:\n")
                    f.write(f"  • Производитель: {self.device.get('vendor_source', 'Не указан')}\n")
                    f.write(f"  • Модель: {self.device.get('model_source', 'Не указан')}\n\n")
                    
                    f.write(f"Детали: {self.device.get('match_details', 'Нет дополнительной информации')}\n")
                
                QMessageBox.information(self, "Успех", f"Аналитика сохранена в:\n{filename}")
            except Exception as e:
                QMessageBox.warning(self, "Ошибка", f"Не удалось сохранить аналитику: {str(e)}")


# ==================== ДИАЛОГ ИСТОРИИ ИЗМЕНЕНИЙ ПО ДАТАМ ====================

class DateRangeHistoryDialog(QDialog):
    def __init__(self, mac_history_db: MACHistoryDatabase, parent=None):
        super().__init__(parent)
        self.mac_history_db = mac_history_db
        self.setWindowTitle("История изменений по датам")
        self.setModal(True)
        self.setGeometry(100, 100, 1400, 850)
        self.setStyleSheet(parent.styleSheet() if parent else "")
        self.init_ui()
        self.load_all_changes()
    
    def init_ui(self):
        layout = QVBoxLayout()
        
        title = QLabel("📅 История изменений по датам")
        title.setFont(QFont("Segoe UI", 16, QFont.Bold))
        layout.addWidget(title)
        
        # Панель выбора дат
        date_panel = QGroupBox("Выбор периода")
        date_layout = QHBoxLayout()
        
        date_layout.addWidget(QLabel("Начальная дата:"))
        self.start_date = QDateEdit()
        self.start_date.setCalendarPopup(True)
        self.start_date.setDate(QDate.currentDate().addDays(-30))
        self.start_date.setDisplayFormat("dd.MM.yyyy")
        date_layout.addWidget(self.start_date)
        
        date_layout.addWidget(QLabel("Конечная дата:"))
        self.end_date = QDateEdit()
        self.end_date.setCalendarPopup(True)
        self.end_date.setDate(QDate.currentDate())
        self.end_date.setDisplayFormat("dd.MM.yyyy")
        date_layout.addWidget(self.end_date)
        
        self.show_all_btn = QPushButton("Показать все изменения")
        self.show_all_btn.clicked.connect(self.load_all_changes)
        date_layout.addWidget(self.show_all_btn)
        
        self.apply_btn = QPushButton("Применить период")
        self.apply_btn.clicked.connect(self.load_changes_by_date)
        date_layout.addWidget(self.apply_btn)
        
        date_panel.setLayout(date_layout)
        layout.addWidget(date_panel)
        
        # Вкладки
        tabs = QTabWidget()
        
        # Вкладка изменений по датам
        changes_tab = QWidget()
        changes_layout = QVBoxLayout(changes_tab)
        
        self.changes_table = QTableWidget()
        self.changes_table.setColumnCount(8)
        self.changes_table.setHorizontalHeaderLabels([
            "Дата", "MAC-адрес", "Поле", "Было", "Стало", "Файл", "Тип", "Подробнее"
        ])
        self.changes_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.changes_table.itemDoubleClicked.connect(self.on_change_double_click)
        changes_layout.addWidget(self.changes_table)
        
        tabs.addTab(changes_tab, "🔄 Все изменения")
        
        # Вкладка статистики по датам
        stats_tab = QWidget()
        stats_layout = QVBoxLayout(stats_tab)
        
        self.stats_table = QTableWidget()
        self.stats_table.setColumnCount(5)
        self.stats_table.setHorizontalHeaderLabels([
            "Дата", "Всего изменений", "Добавлено", "Удалено", "Изменено"
        ])
        self.stats_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        stats_layout.addWidget(self.stats_table)
        
        tabs.addTab(stats_tab, "📊 Статистика по датам")
        
        # Вкладка топ изменяемых MAC
        top_mac_tab = QWidget()
        top_mac_layout = QVBoxLayout(top_mac_tab)
        
        self.top_mac_table = QTableWidget()
        self.top_mac_table.setColumnCount(3)
        self.top_mac_table.setHorizontalHeaderLabels([
            "MAC-адрес", "Количество изменений", "Последнее изменение"
        ])
        self.top_mac_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        top_mac_layout.addWidget(self.top_mac_table)
        
        tabs.addTab(top_mac_tab, "🏆 Наиболее изменяемые MAC")
        
        layout.addWidget(tabs)
        
        # Кнопки экспорта
        btn_layout = QHBoxLayout()
        self.export_btn = QPushButton("📎 Экспорт истории изменений")
        self.export_btn.clicked.connect(self.export_history)
        btn_layout.addWidget(self.export_btn)
        
        self.refresh_btn = QPushButton("🔄 Обновить")
        self.refresh_btn.clicked.connect(self.load_all_changes)
        btn_layout.addWidget(self.refresh_btn)
        
        btn_layout.addStretch()
        
        close_btn = QPushButton("Закрыть")
        close_btn.clicked.connect(self.accept)
        btn_layout.addWidget(close_btn)
        
        layout.addLayout(btn_layout)
        
        self.setLayout(layout)
    
    def load_all_changes(self):
        """Загрузка всех изменений без ограничения по датам"""
        self.load_changes_by_date(None, None)
    
    def load_changes_by_date(self):
        """Загрузка изменений за выбранный период"""
        start_qdate = self.start_date.date()
        end_qdate = self.end_date.date()
        
        start_date = datetime(start_qdate.year(), start_qdate.month(), start_qdate.day())
        end_date = datetime(end_qdate.year(), end_qdate.month(), end_qdate.day(), 23, 59, 59)
        
        self.load_changes_by_date(start_date, end_date)
    
    def load_changes_by_date(self, start_date: datetime = None, end_date: datetime = None):
        """Загрузка изменений за период"""
        field_names = {
            'vendor': 'Производитель', 'model': 'Модель', 'ip': 'IP-адрес',
            'address': 'Адрес', 'room': 'Помещение', 'switch_ip': 'IP коммутатора',
            'switch_port': 'Порт'
        }
        
        all_movements = []
        stats_by_date = defaultdict(lambda: {'total': 0, 'added': 0, 'removed': 0, 'modified': 0})
        mac_change_count = defaultdict(int)
        mac_last_change = {}
        
        with self.mac_history_db._get_connection() as conn:
            # Получаем все движения
            cursor = conn.execute('''SELECT mac, from_value, to_value, field_name, timestamp, source_file
                FROM mac_movements ORDER BY timestamp''')
            rows = cursor.fetchall()
            
            for row in rows:
                mac = row[0]
                from_val = row[1]
                to_val = row[2]
                field = row[3]
                timestamp_str = row[4]
                source_file = row[5]
                
                if timestamp_str:
                    try:
                        ts = datetime.fromisoformat(timestamp_str)
                    except:
                        ts = datetime.now()
                else:
                    ts = datetime.now()
                
                # Фильтрация по дате
                if start_date and ts < start_date:
                    continue
                if end_date and ts > end_date:
                    continue
                
                date_str = ts.strftime("%Y-%m-%d")
                
                # Определяем тип изменения
                if from_val == '—' and to_val and to_val not in ['', '—']:
                    change_type = "Добавление"
                    stats_by_date[date_str]['added'] += 1
                elif to_val == '—' and from_val and from_val not in ['', '—']:
                    change_type = "Удаление"
                    stats_by_date[date_str]['removed'] += 1
                else:
                    change_type = "Изменение"
                    stats_by_date[date_str]['modified'] += 1
                
                stats_by_date[date_str]['total'] += 1
                mac_change_count[mac] += 1
                mac_last_change[mac] = date_str
                
                all_movements.append({
                    'timestamp': ts,
                    'date_str': date_str,
                    'mac': mac,
                    'mac_formatted': MACValidator.format_mac(mac),
                    'field': field,
                    'field_name': field_names.get(field, field),
                    'from_value': from_val,
                    'to_value': to_val,
                    'source_file': Path(source_file).name if source_file else '-',
                    'change_type': change_type
                })
        
        # Сортируем по дате (новые сверху)
        all_movements.sort(key=lambda x: x['timestamp'], reverse=True)
        
        # Заполняем таблицу изменений
        self.changes_table.setRowCount(len(all_movements))
        for i, move in enumerate(all_movements):
            self.changes_table.setItem(i, 0, QTableWidgetItem(move['timestamp'].strftime("%Y-%m-%d %H:%M:%S")))
            self.changes_table.setItem(i, 1, QTableWidgetItem(move['mac_formatted']))
            self.changes_table.setItem(i, 2, QTableWidgetItem(move['field_name']))
            self.changes_table.setItem(i, 3, QTableWidgetItem(move['from_value'][:50] if move['from_value'] else '—'))
            self.changes_table.setItem(i, 4, QTableWidgetItem(move['to_value'][:50] if move['to_value'] else '—'))
            self.changes_table.setItem(i, 5, QTableWidgetItem(move['source_file']))
            
            type_item = QTableWidgetItem(move['change_type'])
            if move['change_type'] == "Добавление":
                type_item.setForeground(QColor(76, 175, 80))
            elif move['change_type'] == "Удаление":
                type_item.setForeground(QColor(244, 67, 54))
            else:
                type_item.setForeground(QColor(255, 152, 0))
            self.changes_table.setItem(i, 6, type_item)
            
            details_btn = QPushButton("📋 Детали")
            details_btn.clicked.connect(lambda checked, m=move: self.show_movement_details(m))
            self.changes_table.setCellWidget(i, 7, details_btn)
        
        self.changes_table.resizeColumnsToContents()
        
        # Заполняем таблицу статистики
        stats_list = []
        for date_str, stats in sorted(stats_by_date.items(), key=lambda x: x[0], reverse=True):
            stats_list.append({
                'date': date_str,
                'total': stats['total'],
                'added': stats['added'],
                'removed': stats['removed'],
                'modified': stats['modified']
            })
        
        self.stats_table.setRowCount(len(stats_list))
        for i, stat in enumerate(stats_list):
            self.stats_table.setItem(i, 0, QTableWidgetItem(stat['date']))
            self.stats_table.setItem(i, 1, QTableWidgetItem(str(stat['total'])))
            self.stats_table.setItem(i, 2, QTableWidgetItem(str(stat['added'])))
            self.stats_table.setItem(i, 3, QTableWidgetItem(str(stat['removed'])))
            self.stats_table.setItem(i, 4, QTableWidgetItem(str(stat['modified'])))
        
        self.stats_table.resizeColumnsToContents()
        
        # Заполняем таблицу топ MAC по изменениям
        top_macs = sorted(mac_change_count.items(), key=lambda x: x[1], reverse=True)[:50]
        self.top_mac_table.setRowCount(len(top_macs))
        for i, (mac, count) in enumerate(top_macs):
            self.top_mac_table.setItem(i, 0, QTableWidgetItem(MACValidator.format_mac(mac)))
            self.top_mac_table.setItem(i, 1, QTableWidgetItem(str(count)))
            self.top_mac_table.setItem(i, 2, QTableWidgetItem(mac_last_change.get(mac, '-')))
        
        self.top_mac_table.resizeColumnsToContents()
    
    def on_change_double_click(self, index):
        """Обработка двойного клика по изменению"""
        row = index.row()
        mac_item = self.changes_table.item(row, 1)
        if mac_item:
            mac_text = mac_item.text()
            # Извлекаем чистый MAC без форматирования
            mac_clean = re.sub(r'[^0-9A-Fa-f]', '', mac_text)
            if len(mac_clean) == 12:
                dialog = MACHistoryDialog(mac_clean, self.mac_history_db, self)
                dialog.exec_()
    
    def show_movement_details(self, move):
        """Показать детали изменения"""
        details = f"""
        📋 ДЕТАЛИ ИЗМЕНЕНИЯ
        
        Дата: {move['timestamp'].strftime("%Y-%m-%d %H:%M:%S")}
        MAC-адрес: {move['mac_formatted']}
        Поле: {move['field_name']}
        Тип изменения: {move['change_type']}
        
        Было: {move['from_value'] if move['from_value'] else '(пусто)'}
        Стало: {move['to_value'] if move['to_value'] else '(пусто)'}
        
        Файл: {move['source_file']}
        """
        QMessageBox.information(self, "Детали изменения", details)
    
    def export_history(self):
        """Экспорт истории изменений в Excel"""
        filename, _ = QFileDialog.getSaveFileName(
            self, "Сохранить историю изменений",
            f"changes_history_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx",
            "Excel Files (*.xlsx)"
        )
        
        if filename:
            try:
                start_qdate = self.start_date.date()
                end_qdate = self.end_date.date()
                start_date = datetime(start_qdate.year(), start_qdate.month(), start_qdate.day())
                end_date = datetime(end_qdate.year(), end_qdate.month(), end_qdate.day(), 23, 59, 59)
                
                all_movements = []
                with self.mac_history_db._get_connection() as conn:
                    cursor = conn.execute('''SELECT mac, from_value, to_value, field_name, timestamp, source_file
                        FROM mac_movements ORDER BY timestamp''')
                    rows = cursor.fetchall()
                    
                    for row in rows:
                        mac = row[0]
                        from_val = row[1]
                        to_val = row[2]
                        field = row[3]
                        timestamp_str = row[4]
                        source_file = row[5]
                        
                        if timestamp_str:
                            try:
                                ts = datetime.fromisoformat(timestamp_str)
                            except:
                                ts = datetime.now()
                        else:
                            ts = datetime.now()
                        
                        if ts < start_date or ts > end_date:
                            continue
                        
                        all_movements.append({
                            'Дата': ts.strftime("%Y-%m-%d %H:%M:%S"),
                            'MAC-адрес': MACValidator.format_mac(mac),
                            'Поле': field,
                            'Было': from_val if from_val else '—',
                            'Стало': to_val if to_val else '—',
                            'Файл': Path(source_file).name if source_file else '-'
                        })
                
                if all_movements:
                    df = pd.DataFrame(all_movements)
                    df.to_excel(filename, index=False, sheet_name='История изменений', engine='openpyxl')
                    QMessageBox.information(self, "Успех", f"История изменений сохранена в:\n{filename}")
                else:
                    QMessageBox.warning(self, "Ошибка", "Нет данных для экспорта за выбранный период!")
            except Exception as e:
                QMessageBox.warning(self, "Ошибка", f"Не удалось сохранить историю: {str(e)}")


# ==================== ДИАЛОГ ЭКСПОРТА ====================

class ExportDialog(QDialog):
    def __init__(self, devices, column_manager, parent=None):
        super().__init__(parent)
        self.devices = devices
        self.column_manager = column_manager
        self.setWindowTitle("Экспорт результатов анализа")
        self.setModal(True)
        self.setGeometry(300, 300, 500, 400)
        self.setStyleSheet(parent.styleSheet() if parent else "")
        self.init_ui()
    
    def init_ui(self):
        layout = QVBoxLayout()
        
        title = QLabel("📎 Экспорт результатов")
        title.setFont(QFont("Segoe UI", 14, QFont.Bold))
        layout.addWidget(title)
        
        info_label = QLabel(f"Всего устройств для экспорта: {len(self.devices)}")
        info_label.setStyleSheet("color: #4CAF50; font-weight: bold; padding: 5px;")
        layout.addWidget(info_label)
        
        format_group = QGroupBox("Выбор формата экспорта")
        format_layout = QVBoxLayout()
        
        self.format_combo = QComboBox()
        formats = ["Excel (.xlsx)", "CSV (.csv)", "TXT (.txt)", "HTML (.html)", "JSON (.json)"]
        if YAML_AVAILABLE:
            formats.append("YAML (.yaml)")
        if PDF_AVAILABLE:
            formats.append("PDF (.pdf)")
        self.format_combo.addItems(formats)
        format_layout.addWidget(QLabel("Формат файла:"))
        format_layout.addWidget(self.format_combo)
        
        format_group.setLayout(format_layout)
        layout.addWidget(format_group)
        
        options_group = QGroupBox("Дополнительные опции")
        options_layout = QVBoxLayout()
        
        self.include_headers_cb = QCheckBox("Включать заголовки колонок")
        self.include_headers_cb.setChecked(True)
        options_layout.addWidget(self.include_headers_cb)
        
        self.include_statistics_cb = QCheckBox("Включать статистику")
        self.include_statistics_cb.setChecked(True)
        options_layout.addWidget(self.include_statistics_cb)
        
        options_group.setLayout(options_layout)
        layout.addWidget(options_group)
        
        stats_group = QGroupBox("Статистика экспорта")
        stats_layout = QVBoxLayout()
        
        self.stats_text = QTextEdit()
        self.stats_text.setReadOnly(True)
        self.stats_text.setMaximumHeight(120)
        self.update_stats_preview()
        
        stats_layout.addWidget(self.stats_text)
        stats_group.setLayout(stats_layout)
        layout.addWidget(stats_group)
        
        btn_layout = QHBoxLayout()
        export_btn = QPushButton("📎 Экспортировать")
        export_btn.clicked.connect(self.export)
        btn_layout.addWidget(export_btn)
        
        cancel_btn = QPushButton("Отмена")
        cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(cancel_btn)
        
        layout.addLayout(btn_layout)
        
        self.setLayout(layout)
    
    def update_stats_preview(self):
        devices = self.devices
        total = len(devices)
        with_vendor = len([d for d in devices if d.get('vendor') and d['vendor'] != 'Unknown'])
        with_model = len([d for d in devices if d.get('model') and d['model'] not in ['', 'Unknown', None]])
        with_address = len([d for d in devices if d.get('address') and d['address'] not in ['', 'Unknown', None]])
        with_room = len([d for d in devices if d.get('room') and d['room'] not in ['', 'Unknown', 'Не указано', None]])
        
        stats = f"📊 Статистика экспортируемых данных:\n"
        stats += f"  • Всего устройств: {total}\n"
        stats += f"  • С определенным производителем: {with_vendor} ({with_vendor/total*100:.1f}%)\n"
        stats += f"  • С определенной моделью: {with_model} ({with_model/total*100:.1f}%)\n"
        stats += f"  • С физическим адресом: {with_address} ({with_address/total*100:.1f}%)\n"
        stats += f"  • С указанием помещения: {with_room} ({with_room/total*100:.1f}%)"
        
        self.stats_text.setText(stats)
    
    def export(self):
        if not self.devices:
            QMessageBox.warning(self, "Ошибка", "Нет данных для экспорта!")
            return
        
        format_text = self.format_combo.currentText()
        format_type = format_text.split()[0].lower().replace('(', '').replace(')', '')
        
        default_name = f"mac_analyzer_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.{format_type}"
        
        ext_map = {
            'excel': 'xlsx', 'csv': 'csv', 'txt': 'txt', 'html': 'html',
            'json': 'json', 'yaml': 'yaml', 'pdf': 'pdf'
        }
        ext = ext_map.get(format_type, format_type)
        
        filename, _ = QFileDialog.getSaveFileName(
            self, "Сохранить результаты", default_name, 
            f"{format_text} Files (*.{ext})"
        )
        
        if filename:
            try:
                start_time = time.time()
                success = False
                
                if format_type == 'excel':
                    success = ExportManager.export_to_excel(filename, self.devices, self.column_manager)
                elif format_type == 'csv':
                    success = ExportManager.export_to_csv(filename, self.devices, self.column_manager)
                elif format_type == 'txt':
                    success = ExportManager.export_to_txt(self.devices, filename, self.column_manager)
                elif format_type == 'html':
                    success = ExportManager.export_to_html(filename, self.devices, self.column_manager)
                elif format_type == 'json':
                    success = ExportManager.export_to_json(filename, self.devices, self.column_manager)
                elif format_type == 'yaml' and YAML_AVAILABLE:
                    success = ExportManager.export_to_yaml(filename, self.devices, self.column_manager)
                elif format_type == 'pdf' and PDF_AVAILABLE:
                    success = ExportManager.export_to_pdf_chunked(filename, self.devices, self.column_manager)
                
                if success:
                    elapsed = time.time() - start_time
                    QMessageBox.information(
                        self, "Успех", 
                        f"✅ Экспорт завершен!\n\n"
                        f"Файл: {filename}\n"
                        f"Устройств: {len(self.devices)}\n"
                        f"Формат: {format_text}\n"
                        f"Время экспорта: {elapsed:.2f} сек."
                    )
                    self.accept()
                else:
                    QMessageBox.warning(self, "Ошибка", f"Не удалось сохранить результаты в формате {format_text}")
                    
            except Exception as e:
                QMessageBox.critical(self, "Ошибка", f"Ошибка при экспорте:\n{str(e)}")


# ==================== ДИАЛОГ АНАЛИТИКИ ПО ВСЕМ УСТРОЙСТВАМ ====================

class AnalyticsDialog(QDialog):
    def __init__(self, devices, parent=None):
        super().__init__(parent)
        self.devices = devices
        self.setWindowTitle("Аналитика по всем устройствам")
        self.setModal(True)
        self.setGeometry(100, 100, 1200, 800)
        self.setStyleSheet(parent.styleSheet() if parent else "")
        self.init_ui()
        self.load_analytics()
    
    def init_ui(self):
        layout = QVBoxLayout()
        
        title = QLabel("📊 Аналитика по всем устройствам")
        title.setFont(QFont("Segoe UI", 16, QFont.Bold))
        layout.addWidget(title)
        
        info_label = QLabel(f"Всего устройств в анализе: {len(self.devices)}")
        info_label.setStyleSheet("color: #4CAF50; font-weight: bold; padding: 5px;")
        layout.addWidget(info_label)
        
        tabs = QTabWidget()
        
        # Вкладка общей статистики
        stats_tab = QWidget()
        stats_layout = QVBoxLayout(stats_tab)
        
        scroll_stats = QScrollArea()
        scroll_stats.setWidgetResizable(True)
        stats_content = QWidget()
        stats_form = QFormLayout(stats_content)
        
        self.stats_labels = {}
        stats_fields = [
            ('total_devices', 'Всего устройств'),
            ('with_vendor', 'С определенным производителем'),
            ('with_model', 'С определенной моделью'),
            ('with_address', 'С физическим адресом'),
            ('with_room', 'С помещением'),
            ('with_ip', 'С IP-адресом'),
            ('with_switch_ip', 'С IP коммутатора'),
            ('with_switch_port', 'С портом подключения'),
            ('unique_vendors', 'Уникальных производителей'),
            ('unique_models', 'Уникальных моделей'),
            ('unique_rooms', 'Уникальных помещений'),
            ('unique_switch_ips', 'Уникальных коммутаторов')
        ]
        
        for field, label in stats_fields:
            label_widget = QLabel(label + ":")
            label_widget.setStyleSheet("font-weight: bold;")
            value_widget = QLabel("-")
            value_widget.setStyleSheet("color: #3498db;")
            stats_form.addRow(label_widget, value_widget)
            self.stats_labels[field] = value_widget
        
        scroll_stats.setWidget(stats_content)
        stats_layout.addWidget(scroll_stats)
        tabs.addTab(stats_tab, "📈 Общая статистика")
        
        # Вкладка производителей
        vendors_tab = QWidget()
        vendors_layout = QVBoxLayout(vendors_tab)
        
        self.vendors_table = QTableWidget()
        self.vendors_table.setColumnCount(3)
        self.vendors_table.setHorizontalHeaderLabels(["Производитель", "Количество", "% от общего"])
        self.vendors_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        vendors_layout.addWidget(self.vendors_table)
        tabs.addTab(vendors_tab, "🏭 Производители")
        
        # Вкладка моделей
        models_tab = QWidget()
        models_layout = QVBoxLayout(models_tab)
        
        self.models_table = QTableWidget()
        self.models_table.setColumnCount(3)
        self.models_table.setHorizontalHeaderLabels(["Модель", "Количество", "% от общего"])
        self.models_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        models_layout.addWidget(self.models_table)
        tabs.addTab(models_tab, "📱 Модели")
        
        # Вкладка помещений
        rooms_tab = QWidget()
        rooms_layout = QVBoxLayout(rooms_tab)
        
        self.rooms_table = QTableWidget()
        self.rooms_table.setColumnCount(3)
        self.rooms_table.setHorizontalHeaderLabels(["Помещение", "Количество", "% от общего"])
        self.rooms_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        rooms_layout.addWidget(self.rooms_table)
        tabs.addTab(rooms_tab, "🚪 Помещения")
        
        # Вкладка коммутаторов
        switches_tab = QWidget()
        switches_layout = QVBoxLayout(switches_tab)
        
        self.switches_table = QTableWidget()
        self.switches_table.setColumnCount(3)
        self.switches_table.setHorizontalHeaderLabels(["IP коммутатора", "Количество устройств", "% от общего"])
        self.switches_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        switches_layout.addWidget(self.switches_table)
        tabs.addTab(switches_tab, "🔌 Коммутаторы")
        
        # Вкладка заполненности полей
        completeness_tab = QWidget()
        completeness_layout = QVBoxLayout(completeness_tab)
        
        self.completeness_table = QTableWidget()
        self.completeness_table.setColumnCount(3)
        self.completeness_table.setHorizontalHeaderLabels(["Поле", "Заполнено", "Процент"])
        self.completeness_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        completeness_layout.addWidget(self.completeness_table)
        tabs.addTab(completeness_tab, "📊 Заполненность полей")
        
        layout.addWidget(tabs)
        
        # Кнопки экспорта
        btn_layout = QHBoxLayout()
        export_btn = QPushButton("📎 Экспорт аналитики")
        export_btn.clicked.connect(self.export_analytics)
        btn_layout.addWidget(export_btn)
        
        close_btn = QPushButton("Закрыть")
        close_btn.clicked.connect(self.accept)
        btn_layout.addWidget(close_btn)
        
        layout.addLayout(btn_layout)
        
        self.setLayout(layout)
    
    def load_analytics(self):
        devices = self.devices
        total = len(devices)
        
        if total == 0:
            return
        
        # Общая статистика
        with_vendor = len([d for d in devices if d.get('vendor') and d['vendor'] != 'Unknown'])
        with_model = len([d for d in devices if d.get('model') and d['model'] not in ['', 'Unknown', None]])
        with_address = len([d for d in devices if d.get('address') and d['address'] not in ['', 'Unknown', None]])
        with_room = len([d for d in devices if d.get('room') and d['room'] not in ['', 'Unknown', 'Не указано', None]])
        with_ip = len([d for d in devices if d.get('ip') and d['ip'] not in ['', 'Unknown', None]])
        with_switch_ip = len([d for d in devices if d.get('switch_ip') and d['switch_ip'] not in ['', 'Unknown', None]])
        with_switch_port = len([d for d in devices if d.get('switch_port') and d['switch_port'] not in ['', 'Unknown', None]])
        
        vendors = set([d.get('vendor') for d in devices if d.get('vendor') and d['vendor'] != 'Unknown'])
        models = set([d.get('model') for d in devices if d.get('model') and d['model'] not in ['', 'Unknown', None]])
        rooms = set([d.get('room') for d in devices if d.get('room') and d['room'] not in ['', 'Unknown', 'Не указано', None]])
        switch_ips = set([d.get('switch_ip') for d in devices if d.get('switch_ip') and d['switch_ip'] not in ['', 'Unknown', None]])
        
        stats_values = {
            'total_devices': str(total),
            'with_vendor': f"{with_vendor} ({with_vendor/total*100:.1f}%)",
            'with_model': f"{with_model} ({with_model/total*100:.1f}%)",
            'with_address': f"{with_address} ({with_address/total*100:.1f}%)",
            'with_room': f"{with_room} ({with_room/total*100:.1f}%)",
            'with_ip': f"{with_ip} ({with_ip/total*100:.1f}%)",
            'with_switch_ip': f"{with_switch_ip} ({with_switch_ip/total*100:.1f}%)",
            'with_switch_port': f"{with_switch_port} ({with_switch_port/total*100:.1f}%)",
            'unique_vendors': str(len(vendors)),
            'unique_models': str(len(models)),
            'unique_rooms': str(len(rooms)),
            'unique_switch_ips': str(len(switch_ips))
        }
        
        for field, label_widget in self.stats_labels.items():
            label_widget.setText(stats_values.get(field, "-"))
        
        # Производители
        vendor_counts = Counter([d.get('vendor', 'Unknown') for d in devices])
        self.vendors_table.setRowCount(len(vendor_counts))
        for i, (vendor, count) in enumerate(vendor_counts.most_common()):
            self.vendors_table.setItem(i, 0, QTableWidgetItem(vendor))
            self.vendors_table.setItem(i, 1, QTableWidgetItem(str(count)))
            self.vendors_table.setItem(i, 2, QTableWidgetItem(f"{count/total*100:.1f}%"))
        
        # Модели
        model_counts = Counter([d.get('model', 'Не указана') for d in devices if d.get('model') and d['model'] not in ['', 'Unknown']])
        self.models_table.setRowCount(len(model_counts))
        for i, (model, count) in enumerate(model_counts.most_common(50)):
            self.models_table.setItem(i, 0, QTableWidgetItem(model))
            self.models_table.setItem(i, 1, QTableWidgetItem(str(count)))
            self.models_table.setItem(i, 2, QTableWidgetItem(f"{count/total*100:.1f}%"))
        
        # Помещения
        room_counts = Counter([d.get('room', 'Не указано') for d in devices if d.get('room') and d['room'] not in ['', 'Unknown', 'Не указано']])
        self.rooms_table.setRowCount(len(room_counts))
        for i, (room, count) in enumerate(room_counts.most_common()):
            self.rooms_table.setItem(i, 0, QTableWidgetItem(room))
            self.rooms_table.setItem(i, 1, QTableWidgetItem(str(count)))
            self.rooms_table.setItem(i, 2, QTableWidgetItem(f"{count/total*100:.1f}%"))
        
        # Коммутаторы
        switch_counts = Counter([d.get('switch_ip', 'Не указан') for d in devices if d.get('switch_ip') and d['switch_ip'] not in ['', 'Unknown']])
        self.switches_table.setRowCount(len(switch_counts))
        for i, (switch_ip, count) in enumerate(switch_counts.most_common()):
            self.switches_table.setItem(i, 0, QTableWidgetItem(switch_ip))
            self.switches_table.setItem(i, 1, QTableWidgetItem(str(count)))
            self.switches_table.setItem(i, 2, QTableWidgetItem(f"{count/total*100:.1f}%"))
        
        # Заполненность полей
        fields = [
            ("Производитель", with_vendor),
            ("Модель", with_model),
            ("IP-адрес", with_ip),
            ("Физический адрес", with_address),
            ("Помещение", with_room),
            ("IP коммутатора", with_switch_ip),
            ("Порт подключения", with_switch_port)
        ]
        self.completeness_table.setRowCount(len(fields))
        for i, (field, count) in enumerate(fields):
            self.completeness_table.setItem(i, 0, QTableWidgetItem(field))
            self.completeness_table.setItem(i, 1, QTableWidgetItem(f"{count} / {total}"))
            self.completeness_table.setItem(i, 2, QTableWidgetItem(f"{count/total*100:.1f}%"))
    
    def export_analytics(self):
        """Экспорт аналитики в Excel"""
        if not self.devices:
            QMessageBox.warning(self, "Ошибка", "Нет данных для экспорта!")
            return
        
        filename, _ = QFileDialog.getSaveFileName(
            self, "Сохранить аналитику",
            f"analytics_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx",
            "Excel Files (*.xlsx)"
        )
        
        if filename:
            try:
                with pd.ExcelWriter(filename, engine='openpyxl') as writer:
                    # Статистика
                    stats_data = []
                    field_names = {
                        'total_devices': 'Всего устройств',
                        'with_vendor': 'С определенным производителем',
                        'with_model': 'С определенной моделью',
                        'with_address': 'С физическим адресом',
                        'with_room': 'С помещением',
                        'with_ip': 'С IP-адресом',
                        'with_switch_ip': 'С IP коммутатора',
                        'with_switch_port': 'С портом подключения',
                        'unique_vendors': 'Уникальных производителей',
                        'unique_models': 'Уникальных моделей',
                        'unique_rooms': 'Уникальных помещений',
                        'unique_switch_ips': 'Уникальных коммутаторов'
                    }
                    for field, label_widget in self.stats_labels.items():
                        stats_data.append({
                            'Показатель': field_names.get(field, field),
                            'Значение': label_widget.text()
                        })
                    df_stats = pd.DataFrame(stats_data)
                    df_stats.to_excel(writer, sheet_name='Общая статистика', index=False)
                    
                    # Производители
                    vendor_data = []
                    for row in range(self.vendors_table.rowCount()):
                        vendor_data.append({
                            'Производитель': self.vendors_table.item(row, 0).text(),
                            'Количество': int(self.vendors_table.item(row, 1).text()),
                            'Процент': self.vendors_table.item(row, 2).text()
                        })
                    if vendor_data:
                        df_vendors = pd.DataFrame(vendor_data)
                        df_vendors.to_excel(writer, sheet_name='Производители', index=False)
                    
                    # Модели
                    model_data = []
                    for row in range(self.models_table.rowCount()):
                        model_data.append({
                            'Модель': self.models_table.item(row, 0).text(),
                            'Количество': int(self.models_table.item(row, 1).text()),
                            'Процент': self.models_table.item(row, 2).text()
                        })
                    if model_data:
                        df_models = pd.DataFrame(model_data)
                        df_models.to_excel(writer, sheet_name='Модели', index=False)
                    
                    # Помещения
                    room_data = []
                    for row in range(self.rooms_table.rowCount()):
                        room_data.append({
                            'Помещение': self.rooms_table.item(row, 0).text(),
                            'Количество': int(self.rooms_table.item(row, 1).text()),
                            'Процент': self.rooms_table.item(row, 2).text()
                        })
                    if room_data:
                        df_rooms = pd.DataFrame(room_data)
                        df_rooms.to_excel(writer, sheet_name='Помещения', index=False)
                    
                    # Коммутаторы
                    switch_data = []
                    for row in range(self.switches_table.rowCount()):
                        switch_data.append({
                            'IP коммутатора': self.switches_table.item(row, 0).text(),
                            'Количество устройств': int(self.switches_table.item(row, 1).text()),
                            'Процент': self.switches_table.item(row, 2).text()
                        })
                    if switch_data:
                        df_switches = pd.DataFrame(switch_data)
                        df_switches.to_excel(writer, sheet_name='Коммутаторы', index=False)
                    
                    # Заполненность полей
                    completeness_data = []
                    for row in range(self.completeness_table.rowCount()):
                        completeness_data.append({
                            'Поле': self.completeness_table.item(row, 0).text(),
                            'Заполнено': self.completeness_table.item(row, 1).text(),
                            'Процент': self.completeness_table.item(row, 2).text()
                        })
                    if completeness_data:
                        df_completeness = pd.DataFrame(completeness_data)
                        df_completeness.to_excel(writer, sheet_name='Заполненность полей', index=False)
                
                QMessageBox.information(self, "Успех", f"Аналитика сохранена в:\n{filename}")
            except Exception as e:
                QMessageBox.warning(self, "Ошибка", f"Не удалось сохранить аналитику: {str(e)}")


# ==================== ДИАЛОГ ПРЕФИКСОВ МОДЕЛИ ====================

class ModelPrefixesDialog(QDialog):
    def __init__(self, model_name: str, parent=None):
        super().__init__(parent)
        self.model_name = model_name
        self.setWindowTitle(f"Префиксы для модели: {model_name}")
        self.setModal(True)
        self.setGeometry(300, 300, 700, 500)
        self.setStyleSheet(parent.styleSheet() if parent else "")
        self.init_ui()
        self.load_data()
    
    def init_ui(self):
        layout = QVBoxLayout()
        
        title = QLabel(f"🔍 Префиксы (5 байт MAC) для модели: {self.model_name}")
        title.setFont(QFont("Segoe UI", 14, QFont.Bold))
        layout.addWidget(title)
        
        info_label = QLabel(
            "Ниже перечислены все префиксы MAC-адресов (первые 5 байт / 10 символов),\n"
            "которые в нашей базе данных соответствуют данной модели устройства."
        )
        info_label.setWordWrap(True)
        info_label.setStyleSheet("color: #888; padding: 5px;")
        layout.addWidget(info_label)
        
        export_btn = QPushButton("📎 Экспортировать префиксы")
        export_btn.clicked.connect(self.export_prefixes)
        layout.addWidget(export_btn)
        
        self.table = QTableWidget()
        self.table.setColumnCount(4)
        self.table.setHorizontalHeaderLabels(["Префикс (5 байт)", "Форматированный", "Модель", "Кол-во вхождений"])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        layout.addWidget(self.table)
        
        close_btn = QPushButton("Закрыть")
        close_btn.clicked.connect(self.accept)
        layout.addWidget(close_btn)
        
        self.setLayout(layout)
    
    def export_prefixes(self):
        prefixes = VendorDatabase.get_prefixes_by_model(self.model_name)
        
        filename, _ = QFileDialog.getSaveFileName(
            self, "Сохранить префиксы модели",
            f"model_prefixes_{self.model_name.replace(' ', '_')}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx",
            "Excel Files (*.xlsx)"
        )
        
        if filename:
            try:
                data = []
                history_db = MACHistoryDatabase()
                for prefix, model in prefixes:
                    with history_db._get_connection() as conn:
                        cursor = conn.execute('SELECT COUNT(*) FROM mac_history WHERE mac_5byte = ?', (prefix,))
                        count = cursor.fetchone()[0]
                    data.append({
                        'Префикс (5 байт)': prefix,
                        'Форматированный': format_oui(prefix, 5) if prefix else '-',
                        'Модель': model,
                        'Количество вхождений': count
                    })
                
                df = pd.DataFrame(data)
                df.to_excel(filename, index=False, sheet_name='Префиксы модели', engine='openpyxl')
                
                QMessageBox.information(self, "Успех", f"Префиксы модели сохранены в:\n{filename}")
            except Exception as e:
                QMessageBox.warning(self, "Ошибка", f"Не удалось сохранить префиксы: {str(e)}")
    
    def load_data(self):
        prefixes = VendorDatabase.get_prefixes_by_model(self.model_name)
        
        history_db = MACHistoryDatabase()
        prefix_counts = {}
        with history_db._get_connection() as conn:
            for prefix, model in prefixes:
                cursor = conn.execute('SELECT COUNT(*) FROM mac_history WHERE mac_5byte = ?', (prefix,))
                count = cursor.fetchone()[0]
                prefix_counts[prefix] = count
        
        self.table.setRowCount(len(prefixes))
        for i, (prefix, model) in enumerate(prefixes):
            formatted = format_oui(prefix, 5) if prefix else '-'
            self.table.setItem(i, 0, QTableWidgetItem(prefix))
            self.table.setItem(i, 1, QTableWidgetItem(formatted))
            self.table.setItem(i, 2, QTableWidgetItem(model))
            self.table.setItem(i, 3, QTableWidgetItem(str(prefix_counts.get(prefix, 0))))
        
        self.table.resizeColumnsToContents()


# ==================== БАЗА ДАННЫХ ПРОИЗВОДИТЕЛЕЙ (ИСТОРИЯ) ====================

class VendorModelHistory:
    def __init__(self, db_path: str = "vendor_model_history.db"):
        self.db_path = db_path
        self.init_db()
    
    def _get_connection(self):
        return sqlite3.connect(self.db_path)
    
    def init_db(self):
        with self._get_connection() as conn:
            conn.execute('''CREATE TABLE IF NOT EXISTS oui_vendor_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                oui_3byte TEXT NOT NULL UNIQUE,
                vendor TEXT NOT NULL,
                occurrences INTEGER DEFAULT 1,
                first_seen TIMESTAMP,
                last_seen TIMESTAMP
            )''')
            
            conn.execute('''CREATE TABLE IF NOT EXISTS mac5_model_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mac_5byte TEXT NOT NULL UNIQUE,
                model TEXT NOT NULL,
                occurrences INTEGER DEFAULT 1,
                first_seen TIMESTAMP,
                last_seen TIMESTAMP
            )''')
            
            conn.execute('''CREATE TABLE IF NOT EXISTS history_loads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT,
                load_date TIMESTAMP,
                devices_count INTEGER,
                new_vendors_added INTEGER,
                new_models_added INTEGER,
                enriched_from_history INTEGER
            )''')
            
            conn.execute('CREATE INDEX IF NOT EXISTS idx_oui_vendor ON oui_vendor_history(oui_3byte)')
            conn.execute('CREATE INDEX IF NOT EXISTS idx_mac5_model ON mac5_model_history(mac_5byte)')
            conn.commit()
    
    def add_device_from_scan(self, device: dict, source_file: str = ""):
        mac = device.get('mac')
        if not mac or len(mac) < 12:
            return False
        
        oui_3byte = mac[:6] if len(mac) >= 6 else None
        mac_5byte = mac[:10] if len(mac) >= 10 else None
        vendor = device.get('vendor', '')
        model = device.get('model', '')
        now = datetime.now().isoformat()
        
        with self._get_connection() as conn:
            if vendor and vendor != 'Unknown' and oui_3byte:
                try:
                    conn.execute('''INSERT INTO oui_vendor_history 
                        (oui_3byte, vendor, occurrences, first_seen, last_seen)
                        VALUES (?, ?, 1, ?, ?)
                        ON CONFLICT(oui_3byte) DO UPDATE SET
                        occurrences = occurrences + 1,
                        last_seen = excluded.last_seen,
                        vendor = CASE WHEN excluded.vendor != oui_vendor_history.vendor 
                                     THEN excluded.vendor ELSE oui_vendor_history.vendor END''',
                        (oui_3byte, vendor, now, now))
                except Exception as e:
                    logging.error(f"Ошибка сохранения OUI в историю: {e}")
            
            if model and model not in ['', 'Unknown', 'Не указано'] and mac_5byte:
                try:
                    conn.execute('''INSERT INTO mac5_model_history 
                        (mac_5byte, model, occurrences, first_seen, last_seen)
                        VALUES (?, ?, 1, ?, ?)
                        ON CONFLICT(mac_5byte) DO UPDATE SET
                        occurrences = occurrences + 1,
                        last_seen = excluded.last_seen,
                        model = CASE WHEN excluded.model != mac5_model_history.model 
                                     THEN excluded.model ELSE mac5_model_history.model END''',
                        (mac_5byte, model, now, now))
                except Exception as e:
                    logging.error(f"Ошибка сохранения MAC5 в историю: {e}")
        return True
    
    def add_devices_batch(self, devices: List[dict], source_file: str = ""):
        added_vendors = 0
        added_models = 0
        enriched_from_history = 0
        
        existing_ouis = set()
        existing_mac5 = set()
        with self._get_connection() as conn:
            cursor = conn.execute('SELECT oui_3byte FROM oui_vendor_history')
            for row in cursor:
                existing_ouis.add(row[0])
            cursor = conn.execute('SELECT mac_5byte FROM mac5_model_history')
            for row in cursor:
                existing_mac5.add(row[0])
        
        for dev in devices:
            vendor_source = dev.get('vendor_source', '')
            model_source = dev.get('model_source', '')
            if 'История' in vendor_source or 'История' in model_source:
                enriched_from_history += 1
            
            mac = dev.get('mac', '')
            oui_3byte = mac[:6] if len(mac) >= 6 else None
            mac_5byte = mac[:10] if len(mac) >= 10 else None
            vendor = dev.get('vendor', '')
            model = dev.get('model', '')
            
            if vendor and vendor != 'Unknown' and oui_3byte and oui_3byte not in existing_ouis:
                added_vendors += 1
                existing_ouis.add(oui_3byte)
            
            if model and model not in ['', 'Unknown', 'Не указано'] and mac_5byte and mac_5byte not in existing_mac5:
                added_models += 1
                existing_mac5.add(mac_5byte)
            
            self.add_device_from_scan(dev, source_file)
        
        with self._get_connection() as conn:
            conn.execute('''INSERT INTO history_loads 
                (filename, load_date, devices_count, new_vendors_added, new_models_added, enriched_from_history)
                VALUES (?, ?, ?, ?, ?, ?)''',
                (source_file, datetime.now().isoformat(), len(devices), added_vendors, added_models, enriched_from_history))
            conn.commit()
        return added_vendors, added_models
    
    def get_vendor_from_history(self, mac: str) -> Tuple[Optional[str], float, str]:
        if not mac or len(mac) < 6:
            return None, 0.0, ""
        
        oui_3byte = mac[:6].upper()
        
        with self._get_connection() as conn:
            cursor = conn.execute('''SELECT vendor, occurrences 
                FROM oui_vendor_history WHERE oui_3byte = ?''', (oui_3byte,))
            row = cursor.fetchone()
            if row:
                confidence = min(0.9, 0.5 + min(row[1], 100) * 0.004)
                return row[0], confidence, f"История (OUI: {oui_3byte})"
        return None, 0.0, ""
    
    def get_model_from_history(self, mac: str) -> Tuple[Optional[str], float, str]:
        if not mac or len(mac) < 10:
            return None, 0.0, ""
        
        mac_5byte = mac[:10].upper()
        
        with self._get_connection() as conn:
            cursor = conn.execute('''SELECT model, occurrences 
                FROM mac5_model_history WHERE mac_5byte = ?''', (mac_5byte,))
            row = cursor.fetchone()
            if row:
                confidence = min(0.9, 0.5 + min(row[1], 100) * 0.004)
                return row[0], confidence, f"История (префикс: {mac_5byte})"
        return None, 0.0, ""
    
    def get_statistics(self) -> dict:
        with self._get_connection() as conn:
            cursor = conn.execute('SELECT COUNT(*) FROM oui_vendor_history')
            total_oui = cursor.fetchone()[0]
            cursor = conn.execute('SELECT COUNT(*) FROM mac5_model_history')
            total_mac5 = cursor.fetchone()[0]
            cursor = conn.execute('SELECT COUNT(*) FROM history_loads')
            total_loads = cursor.fetchone()[0]
            cursor = conn.execute('SELECT COUNT(DISTINCT vendor) FROM oui_vendor_history')
            unique_vendors = cursor.fetchone()[0]
        
        return {
            'total_oui_vendor': total_oui,
            'total_mac5_model': total_mac5,
            'total_loads': total_loads,
            'unique_vendors': unique_vendors
        }
    
    def get_history_loads(self, limit: int = 20) -> List[Tuple]:
        with self._get_connection() as conn:
            cursor = conn.execute('''SELECT filename, load_date, devices_count, 
                new_vendors_added, new_models_added, enriched_from_history
                FROM history_loads ORDER BY load_date DESC LIMIT ?''', (limit,))
            return cursor.fetchall()
    
    def search_vendors(self, search_term: str) -> List[Tuple]:
        search_pattern = f"%{search_term}%"
        with self._get_connection() as conn:
            cursor = conn.execute('''SELECT oui_3byte, vendor, occurrences, last_seen
                FROM oui_vendor_history 
                WHERE vendor LIKE ? OR oui_3byte LIKE ?
                ORDER BY occurrences DESC LIMIT 50''',
                (search_pattern, search_pattern))
            return cursor.fetchall()
    
    def search_models(self, search_term: str) -> List[Tuple]:
        search_pattern = f"%{search_term}%"
        with self._get_connection() as conn:
            cursor = conn.execute('''SELECT mac_5byte, model, occurrences, last_seen
                FROM mac5_model_history 
                WHERE model LIKE ? OR mac_5byte LIKE ?
                ORDER BY occurrences DESC LIMIT 50''',
                (search_pattern, search_pattern))
            return cursor.fetchall()
    
    def get_top_vendors(self, limit: int = 20) -> List[Tuple]:
        with self._get_connection() as conn:
            cursor = conn.execute('''SELECT vendor, SUM(occurrences) as total
                FROM oui_vendor_history GROUP BY vendor
                ORDER BY total DESC LIMIT ?''', (limit,))
            return cursor.fetchall()
    
    def get_top_models(self, limit: int = 20) -> List[Tuple]:
        with self._get_connection() as conn:
            cursor = conn.execute('''SELECT model, SUM(occurrences) as total
                FROM mac5_model_history WHERE model IS NOT NULL AND model != ''
                GROUP BY model ORDER BY total DESC LIMIT ?''', (limit,))
            return cursor.fetchall()
    
    def get_all_vendors(self) -> List[Tuple]:
        with self._get_connection() as conn:
            cursor = conn.execute('''SELECT oui_3byte, vendor, occurrences, last_seen FROM oui_vendor_history ORDER BY occurrences DESC''')
            return cursor.fetchall()
    
    def get_all_models(self) -> List[Tuple]:
        with self._get_connection() as conn:
            cursor = conn.execute('''SELECT mac_5byte, model, occurrences, last_seen
                FROM mac5_model_history WHERE model IS NOT NULL AND model != ''
                ORDER BY occurrences DESC''')
            return cursor.fetchall()
    
    def clear_history(self):
        with self._get_connection() as conn:
            conn.execute('DELETE FROM oui_vendor_history')
            conn.execute('DELETE FROM mac5_model_history')
            conn.execute('DELETE FROM history_loads')
            conn.commit()


# ==================== ИСТОРИЧЕСКОЕ ОБОГАЩЕНИЕ ====================

class HistoryEnricher:
    def __init__(self):
        self.history_db = VendorModelHistory()
        self.enabled = True
        self.priority_history = True
        self.use_oui_match = True
        self.use_mac5_match = True
    
    def enrich_device_from_history(self, device: dict) -> Tuple[bool, bool, str]:
        mac = device.get('mac')
        if not mac:
            return False, False, ""
        
        vendor_updated = False
        model_updated = False
        sources = []
        
        current_vendor = device.get('vendor', 'Unknown')
        current_model = device.get('model', '')
        
        if self.use_oui_match:
            hist_vendor, hist_confidence, hist_source = self.history_db.get_vendor_from_history(mac)
            if hist_vendor and hist_vendor != 'Unknown':
                if self.priority_history or current_vendor == 'Unknown':
                    if current_vendor == 'Unknown' or hist_confidence > device.get('vendor_confidence', 0):
                        device['vendor'] = hist_vendor
                        device['vendor_confidence'] = hist_confidence
                        device['vendor_source'] = hist_source
                        vendor_updated = True
                        sources.append(hist_source)
        
        if self.use_mac5_match:
            hist_model, hist_confidence, hist_source = self.history_db.get_model_from_history(mac)
            if hist_model and hist_model not in ['', 'Unknown', 'Не указано']:
                if self.priority_history or not current_model or current_model in ['', 'Unknown', 'Не указано']:
                    if not current_model or current_model in ['', 'Unknown', 'Не указано'] or hist_confidence > device.get('model_confidence', 0):
                        device['model'] = hist_model
                        device['model_confidence'] = hist_confidence
                        device['model_source'] = hist_source
                        model_updated = True
                        sources.append(hist_source)
        
        return vendor_updated, model_updated, ", ".join(sources)
    
    def enrich_devices_from_history(self, devices: List[dict]) -> Tuple[List[dict], dict]:
        if not self.enabled:
            return devices, {'enriched_vendor': 0, 'enriched_model': 0}
        
        enriched_vendor = 0
        enriched_model = 0
        
        for dev in devices:
            vendor_upd, model_upd, _ = self.enrich_device_from_history(dev)
            if vendor_upd:
                enriched_vendor += 1
            if model_upd:
                enriched_model += 1
        
        return devices, {
            'enriched_vendor': enriched_vendor,
            'enriched_model': enriched_model,
            'total_devices': len(devices)
        }
    
    def set_settings(self, enabled: bool = None, priority_history: bool = None,
                     use_oui_match: bool = None, use_mac5_match: bool = None):
        if enabled is not None:
            self.enabled = enabled
        if priority_history is not None:
            self.priority_history = priority_history
        if use_oui_match is not None:
            self.use_oui_match = use_oui_match
        if use_mac5_match is not None:
            self.use_mac5_match = use_mac5_match
    
    def get_stats(self) -> dict:
        return self.history_db.get_statistics()
    
    def save_scan_to_history(self, devices: List[dict], filename: str):
        return self.history_db.add_devices_batch(devices, filename)


# ==================== РАСШИРЕННОЕ ОПРЕДЕЛЕНИЕ ПРОИЗВОДИТЕЛЯ И МОДЕЛИ ====================

class VendorDetector:
    VENDOR_KEYWORDS = {
        'Apple': ['apple', 'iphone', 'ipad', 'macbook', 'imac', 'mac', 'ios', 'ipod', 'airport'],
        'Samsung': ['samsung', 'galaxy', 'note', 's series', 'gear', 'odyssey', 'ssd'],
        'Huawei': ['huawei', 'honor', 'mate', 'p series', 'mediapad', 'ascend'],
        'Xiaomi': ['xiaomi', 'mi ', 'redmi', 'poco', 'black shark', 'mijia'],
        'Lenovo': ['lenovo', 'thinkpad', 'ideapad', 'yoga', 'legion', 'thinkcentre'],
        'Dell': ['dell', 'xps', 'latitude', 'inspiron', 'precision', 'alienware', 'poweredge'],
        'HP': ['hp', 'hewlett packard', 'elitebook', 'probook', 'spectre', 'envy', 'pavilion', 'laserjet'],
        'Acer': ['acer', 'aspire', 'predator', 'nitro', 'swift', 'travelmate'],
        'ASUS': ['asus', 'rog', 'zenbook', 'vivobook', 'tuf', 'prime', 'expertbook'],
        'Microsoft': ['microsoft', 'surface', 'xbox', 'hololens', 'windows', 'lumia'],
        'Cisco': ['cisco', 'catalyst', 'meraki', 'asa', 'nexus', 'router', 'switch', 'firepower'],
        'Juniper': ['juniper', 'mx', 'ex', 'srx', 'qfx', 'netscreen'],
        'TP-Link': ['tp-link', 'tplink', 'archer', 'deco', 'kasa', 'tapo'],
        'Netgear': ['netgear', 'orbi', 'nighthawk', 'prosafe', 'insight'],
        'Intel': ['intel', 'core i', 'xeon', 'pentium', 'celeron', 'ethernet'],
        'AMD': ['amd', 'ryzen', 'threadripper', 'epyc', 'radeon', 'athlon'],
        'NVIDIA': ['nvidia', 'geforce', 'quadro', 'tesla', 'rtx', 'gtx'],
        'Raspberry Pi': ['raspberry', 'rpi', 'pi 3', 'pi 4', 'pi 5', 'pico'],
        'Arduino': ['arduino', 'uno', 'mega', 'nano', 'esp'],
        'ESP32': ['esp32', 'esp8266', 'espressif'],
    }
    
    _vendor_cache = {}
    _model_cache = {}
    
    def __init__(self):
        self.enabled = True
        self.use_oui_3byte = True
        self.use_oui_5byte = True
        self.use_text_analysis = True
        self.use_inference = True
        self.confidence_threshold = 0.6
        self._device_vendor_map = {}
        self._device_model_map = {}
    
    def detect_vendor_by_oui(self, mac: str) -> Tuple[Optional[str], float]:
        if not self.use_oui_3byte or not mac or len(mac) < 6:
            return None, 0.0
        
        oui = mac[:6]
        vendor = VendorDatabase.get_vendor_by_oui(oui)
        
        if vendor and vendor != 'Unknown':
            return vendor, 0.95
        return None, 0.0
    
    def detect_model_by_mac_prefix(self, mac: str) -> Tuple[Optional[str], float]:
        if not self.use_oui_5byte or not mac or len(mac) < 10:
            return None, 0.0
        
        mac_prefix = mac[:10]
        
        if mac_prefix in self._model_cache:
            return self._model_cache[mac_prefix], 0.85
        
        model = VendorDatabase.get_model_by_prefix(mac_prefix)
        if model:
            self._model_cache[mac_prefix] = model
            return model, 0.85
        
        mac_prefix_8 = mac[:8]
        for key, m in VendorDatabase.MAC5_PREFIX_MODELS.items():
            if key.startswith(mac_prefix_8):
                self._model_cache[mac_prefix] = m
                return m, 0.75
        
        return None, 0.0
    
    def extract_vendor_from_text(self, text: str) -> Tuple[Optional[str], float]:
        if not self.use_text_analysis or not text:
            return None, 0.0
        
        text_lower = text.lower()
        best_match = None
        best_score = 0.0
        
        for vendor, keywords in self.VENDOR_KEYWORDS.items():
            score = 0
            for kw in keywords:
                if kw in text_lower:
                    score += 1
            
            if score > 0:
                confidence = min(score / len(keywords) * 2, 1.0) if keywords else 0
                if confidence > best_score:
                    best_score = confidence
                    best_match = vendor
        
        return best_match, best_score
    
    def infer_from_similar_devices(self, mac: str, devices: List[dict]) -> Tuple[Optional[str], Optional[str], float]:
        if not self.use_inference or not mac or not devices:
            return None, None, 0.0
        
        mac_prefix = mac[:8] if len(mac) >= 8 else mac
        similar_devices = []
        
        for dev in devices:
            dev_mac = dev.get('mac', '')
            if dev_mac and dev_mac.startswith(mac_prefix) and dev_mac != mac:
                vendor = dev.get('vendor', '')
                model = dev.get('model', '')
                if vendor and vendor != 'Unknown':
                    similar_devices.append((vendor, model, dev.get('vendor_confidence', 0)))
        
        if similar_devices:
            vendor_counts = Counter([v for v, _, _ in similar_devices])
            if vendor_counts:
                best_vendor = vendor_counts.most_common(1)[0][0]
                for v, m, _ in similar_devices:
                    if v == best_vendor and m:
                        return best_vendor, m, 0.7
        
        return None, None, 0.0
    
    def detect_vendor_from_device(self, device: dict, all_devices: List[dict] = None) -> Tuple[Optional[str], float, str]:
        if not self.enabled:
            return None, 0.0, "Функция отключена"
        
        mac = device.get('mac', '')
        current_vendor = device.get('vendor', '')
        
        # Если производитель уже есть из файла - не перезаписываем
        if current_vendor and current_vendor != 'Unknown':
            return current_vendor, 1.0, "Из поля Производитель"
        
        candidates = []
        
        oui_vendor, oui_conf = self.detect_vendor_by_oui(mac)
        if oui_vendor:
            candidates.append((oui_vendor, oui_conf, f"По OUI {mac[:6]}:{mac[6:8] if len(mac)>8 else ''}"))
        
        if self.use_text_analysis:
            text_fields = []
            for field in ['model', 'description', 'name', 'hostname', 'device_name']:
                if device.get(field):
                    text_fields.append(str(device[field]))
            
            for text in text_fields:
                text_vendor, text_conf = self.extract_vendor_from_text(text)
                if text_vendor:
                    candidates.append((text_vendor, text_conf * 0.8, f"По тексту: {text[:50]}"))
        
        if all_devices and self.use_inference:
            infer_vendor, infer_model, infer_conf = self.infer_from_similar_devices(mac, all_devices)
            if infer_vendor:
                candidates.append((infer_vendor, infer_conf, f"Инференс из {len([d for d in all_devices if d.get('mac', '').startswith(mac[:8])])} похожих устройств"))
        
        if candidates:
            best = max(candidates, key=lambda x: x[1])
            if best[1] >= self.confidence_threshold:
                if mac:
                    self._device_vendor_map[mac] = best[0]
                return best[0], best[1], best[2]
        
        return None, 0.0, "Не определен"
    
    def detect_model_from_device(self, device: dict, all_devices: List[dict] = None) -> Tuple[Optional[str], float, str]:
        if not self.enabled:
            return None, 0.0, "Функция отключена"
        
        mac = device.get('mac', '')
        current_model = device.get('model', '')
        
        # Если модель уже есть из файла - не перезаписываем
        if current_model and current_model not in ['', 'Unknown', 'Не указано']:
            return current_model, 1.0, "Из поля Модель"
        
        candidates = []
        
        mac5_model, mac5_conf = self.detect_model_by_mac_prefix(mac)
        if mac5_model:
            candidates.append((mac5_model, mac5_conf, f"По префиксу MAC {mac[:10]}"))
        
        if self.use_text_analysis:
            model_text = device.get('model', '')
            if model_text:
                candidates.append((model_text, 0.7, "Из поля Модель"))
        
        if all_devices and self.use_inference:
            infer_vendor, infer_model, infer_conf = self.infer_from_similar_devices(mac, all_devices)
            if infer_model:
                candidates.append((infer_model, infer_conf * 0.9, f"Инференс из похожих устройств"))
        
        if candidates:
            best = max(candidates, key=lambda x: x[1])
            if best[1] >= self.confidence_threshold:
                if mac:
                    self._device_model_map[mac] = best[0]
                return best[0], best[1], best[2]
        
        return None, 0.0, "Не определена"
    
    def enrich_devices(self, devices: List[dict]) -> Tuple[List[dict], dict]:
        enriched_vendor_count = 0
        enriched_model_count = 0
        stats = {
            'total': len(devices),
            'vendor_from_oui': 0,
            'vendor_from_text': 0,
            'vendor_from_inference': 0,
            'model_from_mac5': 0,
            'model_from_text': 0,
            'model_from_inference': 0,
            'vendor_unknown': 0,
            'model_unknown': 0
        }
        
        for dev in devices:
            current_vendor = dev.get('vendor', 'Unknown')
            if not current_vendor or current_vendor == 'Unknown':
                vendor, confidence, source = self.detect_vendor_from_device(dev, devices)
                if vendor:
                    dev['vendor'] = vendor
                    dev['vendor_confidence'] = confidence
                    dev['vendor_source'] = source
                    enriched_vendor_count += 1
                    
                    if 'OUI' in source:
                        stats['vendor_from_oui'] += 1
                    elif 'тексту' in source or 'text' in source.lower():
                        stats['vendor_from_text'] += 1
                    elif 'инференс' in source or 'inference' in source.lower():
                        stats['vendor_from_inference'] += 1
                else:
                    stats['vendor_unknown'] += 1
            
            current_model = dev.get('model', '')
            if not current_model or current_model == '':
                model, confidence, source = self.detect_model_from_device(dev, devices)
                if model:
                    dev['model'] = model
                    dev['model_confidence'] = confidence
                    dev['model_source'] = source
                    enriched_model_count += 1
                    
                    if 'префиксу MAC' in source:
                        stats['model_from_mac5'] += 1
                    elif 'тексту' in source or 'text' in source.lower():
                        stats['model_from_text'] += 1
                    elif 'инференс' in source:
                        stats['model_from_inference'] += 1
                else:
                    stats['model_unknown'] += 1
        
        stats['enriched_vendor'] = enriched_vendor_count
        stats['enriched_model'] = enriched_model_count
        
        logging.info(f"Обогащение: производителей={enriched_vendor_count} (OUI={stats['vendor_from_oui']}), "
                    f"моделей={enriched_model_count} (MAC5={stats['model_from_mac5']})")
        
        return devices, stats
    
    def clear_cache(self):
        self._device_vendor_map.clear()
        self._device_model_map.clear()
        self._vendor_cache.clear()
        self._model_cache.clear()
    
    def get_stats(self) -> dict:
        return {
            'cache_size_vendor': len(self._device_vendor_map),
            'cache_size_model': len(self._device_model_map),
            'enabled': self.enabled,
            'use_oui_3byte': self.use_oui_3byte,
            'use_oui_5byte': self.use_oui_5byte,
            'use_text_analysis': self.use_text_analysis,
            'use_inference': self.use_inference,
            'confidence_threshold': self.confidence_threshold
        }
    
    def add_custom_mac5_mapping(self, prefix_5byte: str, model: str) -> bool:
        return VendorDatabase.add_custom_mapping(prefix_5byte, model)


# ==================== IP-ФИЗИЧЕСКИЙ АДРЕС МЭППИНГ ====================

class IPToAddressMapper:
    def __init__(self):
        self.ip_to_address_map = {}
        self.address_to_ip_map = {}
        self.mapping_file = None
        self.auto_detected = False
        self.mapping_history = []
        self.enrichment_enabled = True
        self.partial_match_enabled = True
        self.overwrite_existing = False
    
    def load_mapping_from_file(self, filepath: str, ip_col: str = None, address_col: str = None) -> int:
        try:
            if filepath.endswith('.csv'):
                df = pd.read_csv(filepath, encoding='utf-8', dtype=str)
            else:
                df = pd.read_excel(filepath, dtype=str, engine='openpyxl')
            
            if df.empty:
                return 0
            
            if ip_col is None or address_col is None:
                headers = df.columns.tolist() if isinstance(df.columns, pd.Index) else [str(c) for c in range(len(df.columns))]
                ip_col_found = None
                address_col_found = None
                
                for i, col in enumerate(df.columns):
                    col_data = df.iloc[:20, i].dropna().astype(str)
                    if len(col_data) > 0:
                        ip_matches = sum(1 for v in col_data if validate_ip(v))
                        if ip_matches > len(col_data) * 0.3:
                            ip_col_found = col
                        address_keywords = ['address', 'адрес', 'location', 'место', 'building']
                        col_lower = str(col).lower()
                        if any(kw in col_lower for kw in address_keywords):
                            address_col_found = col
                
                if ip_col_found is None and ip_col is None:
                    return 0
                ip_col = ip_col_found if ip_col is None else ip_col
                address_col = address_col_found if address_col is None else address_col
            
            count = 0
            for _, row in df.iterrows():
                ip_val = row[ip_col] if ip_col in df.columns else None
                address_val = row[address_col] if address_col in df.columns else None
                
                if pd.notna(ip_val) and pd.notna(address_val):
                    ip_str = str(ip_val).strip()
                    address_str = str(address_val).strip()
                    if validate_ip(ip_str) and address_str and address_str not in ['nan', 'None', '']:
                        self.add_mapping(ip_str, address_str, source=f"Файл: {Path(filepath).name}")
                        count += 1
            
            self.mapping_file = filepath
            return count
        except Exception as e:
            logging.error(f"Ошибка загрузки файла соответствий: {e}")
            return 0
    
    def add_mapping(self, ip: str, address: str, source: str = "Ручное добавление") -> bool:
        if validate_ip(ip) and address and address not in ['Unknown', 'None', '']:
            old_address = self.ip_to_address_map.get(ip)
            if old_address != address:
                self.ip_to_address_map[ip] = address
                self.address_to_ip_map[address] = ip
                self.mapping_history.append({
                    'timestamp': datetime.now().isoformat(),
                    'ip': ip,
                    'old_address': old_address,
                    'new_address': address,
                    'source': source
                })
                return True
        return False
    
    def get_address_by_ip(self, ip: str, use_partial_match: bool = True) -> Optional[str]:
        if not ip or not self.enrichment_enabled:
            return None
        ip_str = str(ip).strip()
        if ip_str in self.ip_to_address_map:
            return self.ip_to_address_map[ip_str]
        if use_partial_match and self.partial_match_enabled:
            ip_parts = ip_str.split('.')
            if len(ip_parts) >= 3:
                subnet = '.'.join(ip_parts[:3])
                for stored_ip, address in self.ip_to_address_map.items():
                    if stored_ip.startswith(subnet):
                        return address
        return None
    
    def auto_detect_from_devices(self, devices: List[dict]) -> int:
        count = 0
        for dev in devices:
            switch_ip = dev.get('switch_ip', '')
            address = dev.get('address', '')
            if switch_ip and address:
                if validate_ip(switch_ip) and address not in ['Unknown', '', 'Не указано']:
                    if switch_ip not in self.ip_to_address_map:
                        self.add_mapping(switch_ip, address, source="Автоопределение из данных")
                        count += 1
        self.auto_detected = True
        return count
    
    def clear(self):
        self.ip_to_address_map.clear()
        self.address_to_ip_map.clear()
        self.mapping_file = None
        self.auto_detected = False
        self.mapping_history = []
    
    def get_stats(self) -> dict:
        return {
            'total_mappings': len(self.ip_to_address_map),
            'unique_ips': len(self.ip_to_address_map),
            'has_file': self.mapping_file is not None,
            'auto_detected': self.auto_detected,
            'history_count': len(self.mapping_history),
            'enrichment_enabled': self.enrichment_enabled,
            'partial_match_enabled': self.partial_match_enabled
        }
    
    def export_mappings(self, filename: str, format_type: str = 'excel') -> bool:
        try:
            data = []
            for ip, address in self.ip_to_address_map.items():
                data.append({'IP контроллера': ip, 'Физический адрес': address})
            if not data:
                return False
            df = pd.DataFrame(data)
            if format_type == 'excel':
                df.to_excel(filename, index=False, sheet_name='IP_Address_Mapping', engine='openpyxl')
            elif format_type == 'csv':
                df.to_csv(filename, index=False, encoding='utf-8-sig')
            elif format_type == 'json':
                with open(filename, 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
            return True
        except Exception as e:
            logging.error(f"Ошибка экспорта соответствий: {e}")
            return False
    
    def set_settings(self, enrichment_enabled: bool = None, partial_match_enabled: bool = None, 
                     overwrite_existing: bool = None):
        if enrichment_enabled is not None:
            self.enrichment_enabled = enrichment_enabled
        if partial_match_enabled is not None:
            self.partial_match_enabled = partial_match_enabled
        if overwrite_existing is not None:
            self.overwrite_existing = overwrite_existing


# ==================== АВТООПРЕДЕЛЕНИЕ КОЛОНОК ====================

class AutoColumnDetector:
    @staticmethod
    def detect_column_type(series):
        if series.empty:
            return 'unknown'
        sample = series.dropna().head(10).astype(str)
        sample = sample[sample != 'nan']
        if len(sample) == 0:
            return 'unknown'
        
        mac_pattern = r'^([0-9A-F]{2}[:-]){5}[0-9A-F]{2}$|^[0-9A-F]{12}$'
        mac_matches = sum(1 for v in sample if re.match(mac_pattern, v.upper(), re.IGNORECASE))
        if len(sample) > 0 and mac_matches > len(sample) * 0.5:
            return 'mac'
        
        ip_pattern = r'^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$'
        ip_matches = sum(1 for v in sample if re.match(ip_pattern, v))
        if len(sample) > 0 and ip_matches > len(sample) * 0.5:
            return 'ip'
        
        vendors = ['Intel', 'Apple', 'Samsung', 'Cisco', 'Dell', 'HP', 'Microsoft', 'Google']
        vendor_matches = sum(1 for v in sample if any(vend in v for vend in vendors))
        if len(sample) > 0 and vendor_matches > len(sample) * 0.3:
            return 'vendor'
        
        address_pattern = r'^\d{1,5}\s+\w+'
        address_matches = sum(1 for v in sample if re.match(address_pattern, v))
        if len(sample) > 0 and address_matches > len(sample) * 0.3:
            return 'address'
        
        rooms = ['Room', 'Office', 'Floor', 'Cabinet', 'Серверная', 'Офис', 'Этаж', 'Кабинет']
        room_matches = sum(1 for v in sample if any(r in v for r in rooms))
        if len(sample) > 0 and room_matches > len(sample) * 0.3:
            return 'room'
        
        switch_ip_pattern = r'^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$'
        if len(sample) > 0 and sum(1 for v in sample if re.match(switch_ip_pattern, v)) > len(sample) * 0.3:
            return 'switch_ip'
        
        port_pattern = r'^(Gi|Fa|Eth|Te|Po|Gig|FastEthernet|Ethernet)\d+[/\d]*$|^\d+$'
        port_matches = sum(1 for v in sample if re.match(port_pattern, v, re.IGNORECASE))
        if len(sample) > 0 and port_matches > len(sample) * 0.3:
            return 'switch_port'
        
        return 'unknown'

    @staticmethod
    def auto_detect_mapping(df, headers, has_headers):
        mapping = {
            'mac_col': None, 'vendor_col': None, 'model_col': None,
            'address_col': None, 'ip_col': None, 'room_col': None,
            'switch_ip_col': None, 'switch_port_col': None
        }
        
        for col_idx in range(min(len(df.columns), 50)):
            col_data = df.iloc[:20, col_idx]
            col_type = AutoColumnDetector.detect_column_type(col_data)
            
            if col_type == 'mac' and mapping['mac_col'] is None:
                if has_headers and headers and col_idx < len(headers):
                    mapping['mac_col'] = headers[col_idx]
                else:
                    mapping['mac_col'] = get_column_letter(col_idx)
            elif col_type == 'vendor' and mapping['vendor_col'] is None:
                if has_headers and headers and col_idx < len(headers):
                    mapping['vendor_col'] = headers[col_idx]
                else:
                    mapping['vendor_col'] = get_column_letter(col_idx)
            elif col_type == 'address' and mapping['address_col'] is None:
                if has_headers and headers and col_idx < len(headers):
                    mapping['address_col'] = headers[col_idx]
                else:
                    mapping['address_col'] = get_column_letter(col_idx)
            elif col_type == 'ip' and mapping['ip_col'] is None:
                if has_headers and headers and col_idx < len(headers):
                    mapping['ip_col'] = headers[col_idx]
                else:
                    mapping['ip_col'] = get_column_letter(col_idx)
            elif col_type == 'room' and mapping['room_col'] is None:
                if has_headers and headers and col_idx < len(headers):
                    mapping['room_col'] = headers[col_idx]
                else:
                    mapping['room_col'] = get_column_letter(col_idx)
            elif col_type == 'switch_ip' and mapping['switch_ip_col'] is None:
                if has_headers and headers and col_idx < len(headers):
                    mapping['switch_ip_col'] = headers[col_idx]
                else:
                    mapping['switch_ip_col'] = get_column_letter(col_idx)
            elif col_type == 'switch_port' and mapping['switch_port_col'] is None:
                if has_headers and headers and col_idx < len(headers):
                    mapping['switch_port_col'] = headers[col_idx]
                else:
                    mapping['switch_port_col'] = get_column_letter(col_idx)
        
        if mapping['mac_col'] is None:
            if has_headers and headers:
                mapping['mac_col'] = headers[0] if headers else 'A'
            else:
                mapping['mac_col'] = 'A'
        
        return mapping


# ==================== AI-АВТООПРЕДЕЛЕНИЕ КОЛОНОК ====================

class AIColumnDetector:
    PATTERNS = {
        'mac': {'patterns': [r'^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$', r'^[0-9A-Fa-f]{12}$'], 'keywords': ['mac', 'address'], 'weight': 1.0},
        'ip': {'patterns': [r'^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$'], 'keywords': ['ip', 'address'], 'weight': 0.9},
        'vendor': {'patterns': [r'vendor', r'manufacturer'], 'keywords': ['vendor', 'manufacturer'], 'weight': 0.8},
        'model': {'patterns': [r'model', r'product'], 'keywords': ['model', 'product'], 'weight': 0.7},
        'address': {'patterns': [r'address', r'location'], 'keywords': ['address', 'location'], 'weight': 0.7},
        'room': {'patterns': [r'room', r'office'], 'keywords': ['room', 'office'], 'weight': 0.8},
        'switch_ip': {'patterns': [r'switch', r'коммутатор'], 'keywords': ['switch'], 'weight': 0.75},
        'switch_port': {'patterns': [r'port', r'interface'], 'keywords': ['port'], 'weight': 0.75}
    }
    
    @classmethod
    def _calculate_similarity(cls, text: str, keywords: list) -> float:
        if not text:
            return 0.0
        text_lower = text.lower()
        matches = sum(1 for kw in keywords if kw.lower() in text_lower)
        return matches / len(keywords) if keywords else 0.0
    
    @classmethod
    def _analyze_sample_data(cls, column_data: pd.Series, column_name: str) -> dict:
        scores = {}
        sample = column_data.dropna().head(50).astype(str)
        sample = sample[sample != 'nan']
        sample = sample[sample != 'None']
        if len(sample) == 0:
            return scores
        
        for field_type, config in cls.PATTERNS.items():
            score = 0.0
            if column_name:
                name_score = cls._calculate_similarity(column_name, config['keywords'])
                score += name_score * 0.25
            
            pattern_matches = 0
            valid_values = 0
            for value in sample:
                if not value or value == 'nan' or value == 'None':
                    continue
                valid_values += 1
                for pattern in config['patterns']:
                    try:
                        if re.match(pattern, value, re.IGNORECASE):
                            pattern_matches += 1
                            break
                    except:
                        pass
            
            if valid_values > 0:
                pattern_score = min(pattern_matches / valid_values, 1.0)
                score += pattern_score * 0.75
            
            scores[field_type] = min(score * config['weight'], 1.0)
        return scores
    
    @classmethod
    def detect_columns_with_ai(cls, df: pd.DataFrame, headers: list, has_headers: bool) -> tuple:
        mapping = {
            'mac_col': None, 'vendor_col': None, 'model_col': None, 'address_col': None,
            'ip_col': None, 'room_col': None, 'switch_ip_col': None, 'switch_port_col': None
        }
        
        if df.empty or len(df.columns) == 0:
            return mapping, {}
        
        candidates = {}
        if has_headers and headers:
            col_names = headers[:len(df.columns)]
        else:
            col_names = [get_column_letter(i) for i in range(len(df.columns))]
        
        for col_idx in range(len(df.columns)):
            col_name = col_names[col_idx] if col_idx < len(col_names) else get_column_letter(col_idx)
            col_data = df.iloc[:100, col_idx]
            if col_data.dropna().empty:
                continue
            scores = cls._analyze_sample_data(col_data, col_name)
            if scores and max(scores.values()) > 0.1:
                candidates[col_idx] = {'name': col_name, 'scores': scores}
        
        used_columns = set()
        
        best_mac = None
        best_mac_score = 0
        for col_idx, cand in candidates.items():
            if col_idx in used_columns:
                continue
            mac_score = cand['scores'].get('mac', 0)
            if mac_score > best_mac_score and mac_score > 0.25:
                best_mac_score = mac_score
                best_mac = col_idx
        
        if best_mac is not None:
            mapping['mac_col'] = col_names[best_mac] if best_mac < len(col_names) else get_column_letter(best_mac)
            used_columns.add(best_mac)
        
        field_mapping = [
            ('vendor', 'vendor_col', 0.2), ('model', 'model_col', 0.2), ('address', 'address_col', 0.2),
            ('ip', 'ip_col', 0.2), ('room', 'room_col', 0.2), ('switch_ip', 'switch_ip_col', 0.2),
            ('switch_port', 'switch_port_col', 0.2)
        ]
        
        for field, field_key, min_score in field_mapping:
            best_col = None
            best_score = 0
            for col_idx, cand in candidates.items():
                if col_idx in used_columns:
                    continue
                score = cand['scores'].get(field, 0)
                if score > best_score and score > min_score:
                    best_score = score
                    best_col = col_idx
            
            if best_col is not None:
                mapping[field_key] = col_names[best_col] if best_col < len(col_names) else get_column_letter(best_col)
                used_columns.add(best_col)
        
        if mapping['mac_col'] is None and len(df.columns) > 0:
            mapping['mac_col'] = col_names[0] if col_names else 'A'
        
        return mapping, candidates


# ==================== ДИАЛОГ ВЫБОРА КОЛОНОК ПРИ КОНФЛИКТЕ ====================

class ColumnConflictDialog(QDialog):
    def __init__(self, candidates, headers, has_headers, df_preview=None, parent=None):
        super().__init__(parent)
        self.candidates = candidates
        self.headers = headers
        self.has_headers = has_headers
        self.df_preview = df_preview
        self.mapping = {}
        self.setWindowTitle("Выбор колонок - AI анализ")
        self.setModal(True)
        self.setGeometry(200, 200, 1100, 700)
        self.setStyleSheet(parent.styleSheet() if parent else "")
        self.init_ui()
    
    def init_ui(self):
        layout = QVBoxLayout()
        title = QLabel("🤖 AI анализ: Обнаружено несколько возможных колонок")
        title.setFont(QFont("Segoe UI", 14, QFont.Bold))
        layout.addWidget(title)
        info_label = QLabel("AI проанализировал данные и предлагает варианты. Выберите колонки для каждого поля.")
        info_label.setWordWrap(True)
        layout.addWidget(info_label)
        
        self.table = QTableWidget()
        self.table.setColumnCount(4)
        self.table.setHorizontalHeaderLabels(["Поле", "Рекомендация AI", "Выберите колонку", "Пример данных"])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        
        fields = [
            ('📡 MAC-адрес', 'mac', True, 'mac'),
            ('🏭 Производитель', 'vendor', False, 'vendor'),
            ('📱 Модель', 'model', False, 'model'),
            ('🌐 IP-адрес', 'ip', False, 'ip'),
            ('📍 Физический адрес', 'address', False, 'address'),
            ('🚪 Помещение', 'room', False, 'room'),
            ('🔌 IP коммутатора', 'switch_ip', False, 'switch_ip'),
            ('🔌 Порт подключения', 'switch_port', False, 'switch_port')
        ]
        
        self.comboboxes = {}
        col_options = ['Не указано']
        for col_idx, cand in self.candidates.items():
            col_options.append(cand['name'])
        
        self.table.setRowCount(len(fields))
        
        for row, (display_name, field_key, required, sample_type) in enumerate(fields):
            name_item = QTableWidgetItem(display_name)
            if required:
                name_item.setForeground(QColor(255, 100, 100))
            self.table.setItem(row, 0, name_item)
            
            best_col = None
            best_score = 0
            best_cand = None
            for col_idx, cand in self.candidates.items():
                score = cand['scores'].get(field_key, 0)
                if score > best_score:
                    best_score = score
                    best_col = col_idx
                    best_cand = cand
            
            if best_col is not None and best_score > 0.15:
                score_percent = int(best_score * 100)
                rec_text = f"{best_cand['name']} (уверенность: {score_percent}%)"
                example_text = ""
                if self.df_preview is not None and best_col < len(self.df_preview.columns):
                    sample_values = self.df_preview.iloc[:3, best_col].dropna().tolist()
                    if sample_values:
                        example_text = ", ".join([str(v)[:30] for v in sample_values[:2]])
            else:
                rec_text = "Не определено (добавьте колонку вручную)"
                example_text = ""
            
            self.table.setItem(row, 1, QTableWidgetItem(rec_text))
            
            combo = QComboBox()
            combo.addItems(col_options)
            if best_col is not None and best_score > 0.15:
                combo.setCurrentText(best_cand['name'])
            combo.setProperty('field_key', field_key)
            self.comboboxes[field_key] = combo
            self.table.setCellWidget(row, 2, combo)
            
            example_item = QTableWidgetItem(example_text)
            example_item.setToolTip(example_text)
            self.table.setItem(row, 3, example_item)
        
        layout.addWidget(self.table)
        
        btn_layout = QHBoxLayout()
        auto_btn = QPushButton("🤖 Довериться AI (автовыбор)")
        auto_btn.clicked.connect(self.auto_select)
        btn_layout.addWidget(auto_btn)
        clear_btn = QPushButton("🗑 Очистить все")
        clear_btn.clicked.connect(self.clear_all)
        btn_layout.addWidget(clear_btn)
        btn_layout.addStretch()
        ok_btn = QPushButton("✅ Применить")
        ok_btn.clicked.connect(self.accept)
        cancel_btn = QPushButton("❌ Отмена")
        cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(ok_btn)
        btn_layout.addWidget(cancel_btn)
        layout.addLayout(btn_layout)
        
        info_panel = QGroupBox("💡 Подсказка")
        info_layout = QVBoxLayout()
        info_text = QLabel("• MAC-адрес — обязательное поле\n• Если колонка не определилась автоматически, выберите её вручную")
        info_text.setWordWrap(True)
        info_layout.addWidget(info_text)
        info_panel.setLayout(info_layout)
        layout.addWidget(info_panel)
        
        self.setLayout(layout)
    
    def auto_select(self):
        for field_key, combo in self.comboboxes.items():
            best_col = None
            best_score = 0
            for col_idx, cand in self.candidates.items():
                score = cand['scores'].get(field_key, 0)
                if score > best_score and score > 0.15:
                    best_score = score
                    best_col = col_idx
            
            if best_col is not None:
                combo.setCurrentText(self.candidates[best_col]['name'])
            else:
                combo.setCurrentText('Не указано')
    
    def clear_all(self):
        for combo in self.comboboxes.values():
            combo.setCurrentText('Не указано')
    
    def get_mapping(self):
        mapping = {}
        for field_key, combo in self.comboboxes.items():
            selected = combo.currentText()
            if selected != 'Не указано':
                mapping[field_key] = selected
        return mapping


# ==================== API КЛИЕНТ ====================

class MACVendorAPI:
    API_SERVICES = {
        'macvendors': {'url': 'https://api.macvendors.com/{}', 'description': 'macvendors.com', 'requires_key': False},
        'maclookup': {'url': 'https://api.maclookup.app/v2/macs/{}/', 'description': 'maclookup.app', 'requires_key': False},
        'mac2vendor': {'url': 'https://mac2vendor.com/api/v1/lookup/{}', 'description': 'mac2vendor.com', 'requires_key': False}
    }
    
    def __init__(self, api_key=None, service='macvendors'):
        self.api_key = api_key
        self.service = service
        self.cache = APICache()
        self.rate_limit_delay = 0.1
        self.last_request_time = 0
        self.request_count = 0
        self.session = requests.Session() if REQUESTS_AVAILABLE else None
        if self.session:
            self.session.headers.update({'User-Agent': 'MAC Analyzer Pro/8.3'})
    
    def is_available(self):
        return REQUESTS_AVAILABLE
    
    def _rate_limit(self):
        current_time = time.time()
        if current_time - self.last_request_time < self.rate_limit_delay:
            time.sleep(self.rate_limit_delay - (current_time - self.last_request_time))
        self.last_request_time = time.time()
        self.request_count += 1
    
    def validate_mac(self, mac: str) -> bool:
        if not mac or pd.isna(mac):
            return False
        mac_clean = re.sub(r'[^0-9A-Fa-f]', '', str(mac)).upper()
        return len(mac_clean) == 12
    
    @cached(maxsize=500)
    def get_vendor_by_mac(self, mac: str) -> Optional[str]:
        if not mac or not self.is_available():
            return None
        if not self.validate_mac(mac):
            return None
        mac_clean = re.sub(r'[^0-9A-Fa-f]', '', mac).upper()
        
        cached_result = self.cache.get(mac_clean)
        if cached_result:
            return cached_result
        
        self._rate_limit()
        try:
            if self.service == 'macvendors':
                url = self.API_SERVICES['macvendors']['url'].format(mac_clean)
                response = self.session.get(url, timeout=10)
                if response.status_code == 200:
                    vendor = response.text.strip()
                    if vendor and 'Not found' not in vendor:
                        self.cache.set(mac_clean, vendor)
                        return vendor
            elif self.service == 'maclookup':
                url = self.API_SERVICES['maclookup']['url'].format(mac_clean)
                response = self.session.get(url, timeout=10)
                if response.status_code == 200:
                    data = response.json()
                    vendor = data.get('vendor', data.get('company', ''))
                    if vendor:
                        self.cache.set(mac_clean, vendor)
                        return vendor
            elif self.service == 'mac2vendor':
                url = self.API_SERVICES['mac2vendor']['url'].format(mac_clean)
                response = self.session.get(url, timeout=10)
                if response.status_code == 200:
                    data = response.json()
                    vendor = data.get('vendor', data.get('company', ''))
                    if vendor:
                        self.cache.set(mac_clean, vendor)
                        return vendor
        except Exception as e:
            logging.error(f"API ошибка: {e}")
        return None
    
    def get_service_list(self):
        return list(self.API_SERVICES.keys())
    
    def set_service(self, service):
        if service in self.API_SERVICES:
            self.service = service
            return True
        return False


# ==================== БАЗА ДАННЫХ ДЛЯ СТАТИСТИКИ ====================

class StatisticsDatabase:
    def __init__(self):
        self.db_path = "mac_analyzer_stats.db"
        self.init_db()

    def _get_connection(self):
        return sqlite3.connect(self.db_path)

    def init_db(self):
        with self._get_connection() as conn:
            conn.execute('''CREATE TABLE IF NOT EXISTS daily_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, total_devices INTEGER,
                new_devices INTEGER, vendors_count INTEGER, rooms_count INTEGER,
                devices_with_address INTEGER, devices_with_room INTEGER)''')
            conn.execute('''CREATE TABLE IF NOT EXISTS analysis_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, filename TEXT,
                devices_count INTEGER, strategy TEXT, processing_time REAL)''')
            conn.execute('''CREATE TABLE IF NOT EXISTS performance_metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT, operation TEXT, timestamp TEXT,
                duration_seconds REAL, details TEXT)''')
            conn.commit()

    def check_and_repair_db(self):
        try:
            with self._get_connection() as conn:
                cursor = conn.execute('PRAGMA integrity_check')
                result = cursor.fetchone()
                if result[0] != 'ok':
                    logging.warning(f"База данных повреждена: {result[0]}")
                    if os.path.exists(self.db_path):
                        backup_path = f"{self.db_path}.backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
                        shutil.copy2(self.db_path, backup_path)
                        logging.info(f"Создана резервная копия: {backup_path}")
                    self.init_db()
                    return False
            return True
        except Exception as e:
            logging.error(f"Ошибка проверки БД: {e}")
            return False

    def save_snapshot(self, devices: list, filename: str = "", strategy: str = "", processing_time: float = 0):
        today = datetime.now().strftime('%Y-%m-%d')
        with self._get_connection() as conn:
            cursor = conn.execute('SELECT id, total_devices FROM daily_stats WHERE date = ?', (today,))
            existing = cursor.fetchone()
            total = len(devices)
            vendors = len(set(d.get('vendor') for d in devices if d.get('vendor') and d['vendor'] != 'Unknown'))
            rooms = len(set(d.get('room') for d in devices if d.get('room') and d['room'] not in ['Unknown', 'Не указано', None]))
            with_address = len([d for d in devices if d.get('address') and d['address'] not in ['Unknown', None, '']])
            with_room = len([d for d in devices if d.get('room') and d['room'] not in ['Unknown', 'Не указано', None, '']])
            if existing:
                old_total = existing[1]
                new_devices = max(0, total - old_total)
                conn.execute('''UPDATE daily_stats SET total_devices=?, new_devices=?, vendors_count=?,
                    rooms_count=?, devices_with_address=?, devices_with_room=? WHERE date=?''',
                    (total, new_devices, vendors, rooms, with_address, with_room, today))
            else:
                conn.execute('''INSERT INTO daily_stats (date, total_devices, new_devices, vendors_count,
                    rooms_count, devices_with_address, devices_with_room) VALUES (?,?,?,?,?,?,?)''',
                    (today, total, total, vendors, rooms, with_address, with_room))
            conn.execute('''INSERT INTO analysis_history (timestamp, filename, devices_count, strategy, processing_time)
                VALUES (?,?,?,?,?)''', (datetime.now().strftime('%Y-%m-%d %H:%M:%S'), filename, total, strategy, processing_time))
            conn.commit()

    def save_performance_metric(self, operation: str, duration: float, details: str = ""):
        with self._get_connection() as conn:
            conn.execute('''INSERT INTO performance_metrics (operation, timestamp, duration_seconds, details)
                VALUES (?,?,?,?)''', (operation, datetime.now().strftime('%Y-%m-%d %H:%M:%S'), duration, details))
            conn.commit()

    def get_trends(self, days: int = 30):
        with self._get_connection() as conn:
            cursor = conn.execute('''SELECT date, total_devices, new_devices, vendors_count, rooms_count
                FROM daily_stats WHERE date >= date('now', ?) ORDER BY date''', (f'-{days} days',))
            return cursor.fetchall()

    def get_analysis_history(self, limit: int = 50):
        with self._get_connection() as conn:
            cursor = conn.execute('''SELECT timestamp, filename, devices_count, strategy, processing_time
                FROM analysis_history ORDER BY timestamp DESC LIMIT ?''', (limit,))
            return cursor.fetchall()
    
    def get_performance_stats(self, operation: str = None, days: int = 7):
        with self._get_connection() as conn:
            if operation:
                cursor = conn.execute('''SELECT operation, AVG(duration_seconds) as avg_duration, 
                    MIN(duration_seconds) as min_duration, MAX(duration_seconds) as max_duration,
                    COUNT(*) as calls_count
                    FROM performance_metrics 
                    WHERE operation = ? AND timestamp >= datetime('now', ?)
                    GROUP BY operation''', (operation, f'-{days} days'))
            else:
                cursor = conn.execute('''SELECT operation, AVG(duration_seconds) as avg_duration, 
                    MIN(duration_seconds) as min_duration, MAX(duration_seconds) as max_duration,
                    COUNT(*) as calls_count
                    FROM performance_metrics 
                    WHERE timestamp >= datetime('now', ?)
                    GROUP BY operation''', (f'-{days} days',))
            return cursor.fetchall()


# ==================== ЛОГГЕР ====================

class AppLogger:
    def __init__(self):
        pass

    def log_action(self, action: str, details: str = ""):
        logging.info(f"{action}: {details}")

    def log_error(self, error: str, details: str = ""):
        logging.error(f"{error}: {details}")


# ==================== АВТОСОХРАНЕНИЕ ====================

class AutoSaveManager:
    def __init__(self, main_window, interval_minutes=5):
        self.main_window = main_window
        self.interval = interval_minutes * 60 * 1000
        self.timer = QTimer()
        self.timer.timeout.connect(self.auto_save)
        self.last_save = None
    
    def start(self):
        self.timer.start(self.interval)
    
    def stop(self):
        self.timer.stop()
    
    def auto_save(self):
        if hasattr(self.main_window, 'current_devices') and self.main_window.current_devices:
            filename = f"autosave_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
            ExportManager.export_to_excel(filename, self.main_window.current_devices, 
                                         self.main_window.column_manager)
            self.last_save = datetime.now()
            self.main_window.status_bar.showMessage(f"Автосохранение: {filename}", 3000)


# ==================== ОБРАБОТЧИК СИГНАЛОВ ====================

class SignalHandler:
    def __init__(self, main_window):
        self.main_window = main_window
        signal.signal(signal.SIGINT, self.signal_handler)
        signal.signal(signal.SIGTERM, self.signal_handler)
    
    def signal_handler(self, signum, frame):
        if hasattr(self.main_window, 'worker') and self.main_window.worker and self.main_window.worker.isRunning():
            self.main_window.worker.cancel()
            self.main_window.worker.wait(5000)
        self.main_window.save_settings()
        self.main_window.logger.log_action("Программа завершена по сигналу", str(signum))
        QApplication.quit()


# ==================== МЕНЕДЖЕР НАСТРОЕК ====================

class SettingsManager:
    def __init__(self):
        self.settings_file = "mac_analyzer_settings.json"

    def save_settings(self, enricher, window_geometry=None, last_strategy=None, oui_formats=None,
                      visible_columns=None, comparison_fields=None, enrich_fields=None, theme=None,
                      api_settings=None, custom_columns=None, ip_address_mapping_file=None,
                      auto_detect_address_by_ip=None, ip_enrichment_settings=None,
                      vendor_detector_settings=None, history_enricher_settings=None,
                      engineering_mode=False):
        geometry_str = None
        if window_geometry is not None and isinstance(window_geometry, QByteArray):
            geometry_str = window_geometry.toBase64().data().decode('ascii')
        settings = {
            'version': '9.0', 'files': {}, 'window_geometry': geometry_str,
            'last_strategy': last_strategy, 'oui_formats': oui_formats or {3: True, 4: False, 5: False, 6: False},
            'visible_columns': visible_columns or [], 'comparison_fields': comparison_fields or {},
            'enrich_fields': enrich_fields or {}, 'theme': theme or 'dark',
            'api_settings': api_settings or {}, 'custom_columns': custom_columns or [],
            'ip_address_mapping_file': ip_address_mapping_file,
            'auto_detect_address_by_ip': auto_detect_address_by_ip if auto_detect_address_by_ip is not None else True,
            'ip_enrichment_settings': ip_enrichment_settings or {},
            'vendor_detector_settings': vendor_detector_settings or {},
            'history_enricher_settings': history_enricher_settings or {},
            'engineering_mode': engineering_mode
        }
        for alias, info in enricher.files.items():
            settings['files'][alias] = {'path': info['path'], 'is_primary': info['is_primary'], 'mapping': info['mapping']}
        try:
            with open(self.settings_file, 'w', encoding='utf-8') as f:
                json.dump(settings, f, ensure_ascii=False, indent=2)
            return True
        except Exception as e:
            logging.error(f"Ошибка сохранения настроек: {e}")
            return False

    def load_settings(self, enricher):
        if not os.path.exists(self.settings_file):
            return None, None, {3: True, 4: False, 5: False, 6: False}, [], {}, {}, 'dark', {}, [], None, True, {}, {}, {}, False
        try:
            with open(self.settings_file, 'r', encoding='utf-8') as f:
                settings = json.load(f)
            for alias, info in settings.get('files', {}).items():
                if os.path.exists(info['path']):
                    enricher.add_file(info['path'], alias, info['is_primary'])
                    enricher.set_mapping(alias, info['mapping'])
            for alias, info in enricher.files.items():
                if info['is_primary']:
                    enricher.primary_alias = alias
                    break
            geometry_str = settings.get('window_geometry')
            geometry = None
            if geometry_str:
                try:
                    geometry = QByteArray.fromBase64(geometry_str.encode('ascii'))
                except:
                    pass
            return (geometry, settings.get('last_strategy'), settings.get('oui_formats', {3: True, 4: False, 5: False, 6: False}),
                    settings.get('visible_columns', []), settings.get('comparison_fields', {}),
                    settings.get('enrich_fields', {}), settings.get('theme', 'dark'),
                    settings.get('api_settings', {}), settings.get('custom_columns', []),
                    settings.get('ip_address_mapping_file'), settings.get('auto_detect_address_by_ip', True),
                    settings.get('ip_enrichment_settings', {}), settings.get('vendor_detector_settings', {}),
                    settings.get('history_enricher_settings', {}), settings.get('engineering_mode', False))
        except Exception as e:
            logging.error(f"Ошибка загрузки настроек: {e}")
            return None, None, {3: True, 4: False, 5: False, 6: False}, [], {}, {}, 'dark', {}, [], None, True, {}, {}, {}, False


# ==================== ОПОВЕЩЕНИЯ ====================

class NotificationService:
    def __init__(self, parent=None):
        self.parent = parent
        self.email_config = {}
        self.telegram_token = None
        self.telegram_chat_id = None
        self.slack_webhook = None
        self.load_config()

    def load_config(self):
        config_file = "notification_config.json"
        if os.path.exists(config_file):
            try:
                with open(config_file, 'r', encoding='utf-8') as f:
                    config = json.load(f)
                    self.email_config = config.get('email', {})
                    self.telegram_token = config.get('telegram_token')
                    self.telegram_chat_id = config.get('telegram_chat_id')
                    self.slack_webhook = config.get('slack_webhook')
            except:
                pass

    def save_config(self):
        config = {'email': self.email_config, 'telegram_token': self.telegram_token,
                  'telegram_chat_id': self.telegram_chat_id, 'slack_webhook': self.slack_webhook}
        try:
            with open('notification_config.json', 'w', encoding='utf-8') as f:
                json.dump(config, f, ensure_ascii=False, indent=2)
        except:
            pass

    def send_email(self, subject, message, to_email=None):
        if not self.email_config.get('enabled') or not self.email_config.get('from_email'):
            return False
        try:
            msg = MIMEMultipart()
            msg['From'] = self.email_config.get('from_email')
            msg['To'] = to_email or self.email_config.get('to_email')
            msg['Subject'] = subject
            msg.attach(MIMEText(message, 'html', 'utf-8'))
            server = smtplib.SMTP(self.email_config.get('smtp_server'), self.email_config.get('smtp_port', 587))
            server.starttls()
            server.login(self.email_config.get('from_email'), self.email_config.get('password'))
            server.send_message(msg)
            server.quit()
            return True
        except Exception as e:
            logging.error(f"Ошибка отправки email: {e}")
            return False

    def send_telegram(self, message):
        if not self.telegram_token or not self.telegram_chat_id or not REQUESTS_AVAILABLE:
            return False
        try:
            url = f"https://api.telegram.org/bot{self.telegram_token}/sendMessage"
            response = requests.post(url, json={'chat_id': self.telegram_chat_id, 'text': message}, timeout=10)
            return response.status_code == 200
        except Exception as e:
            logging.error(f"Ошибка отправки Telegram: {e}")
            return False

    def send_slack(self, message):
        if not self.slack_webhook or not REQUESTS_AVAILABLE:
            return False
        try:
            response = requests.post(self.slack_webhook, json={'text': message}, timeout=10)
            return response.status_code == 200
        except Exception as e:
            logging.error(f"Ошибка отправки Slack: {e}")
            return False

    def on_analysis_complete(self, devices, filename, processing_time=0):
        total = len(devices)
        with_address = len([d for d in devices if d.get('address') and d['address'] not in ['Unknown', None, '']])
        with_room = len([d for d in devices if d.get('room') and d['room'] not in ['Unknown', 'Не указано', None, '']])
        msg = f"Анализ завершен!\nФайл: {filename}\nУстройств: {total}\nАдресов: {with_address}\nПомещений: {with_room}\nВремя обработки: {processing_time:.2f} сек."
        if self.email_config.get('enabled'):
            message = f"""<h3>Анализ завершен</h3><p><b>Файл:</b> {filename}</p>
            <p><b>Всего устройств:</b> {total}</p><p><b>С адресами:</b> {with_address}</p>
            <p><b>С помещениями:</b> {with_room}</p><p><b>Время обработки:</b> {processing_time:.2f} сек.</p>
            <p><b>Время:</b> {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}</p>"""
            self.send_email("MAC Analyzer Pro - Анализ завершен", message)
        if self.telegram_token and self.telegram_chat_id:
            self.send_telegram(msg)
        if self.slack_webhook:
            self.send_slack(msg)


# ==================== ПЛАНИРОВЩИК ЗАДАЧ ====================

class TaskScheduler:
    def __init__(self, parent_window):
        self.parent = parent_window
        self.timer = QTimer()
        self.timer.timeout.connect(self.run_scheduled_analysis)
        self.scheduled_time = None
        self.scheduled_files = []

    def schedule_daily_analysis(self, hour, minute, files):
        self.scheduled_files = files
        now = datetime.now()
        target_time = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if target_time < now:
            target_time += timedelta(days=1)
        delay = (target_time - now).total_seconds() * 1000
        self.timer.start(int(delay))
        self.scheduled_time = target_time
        return f"Анализ запланирован на {target_time.strftime('%Y-%m-%d %H:%M:%S')}"

    def run_scheduled_analysis(self):
        if self.scheduled_files:
            self.parent.run_scheduled_analysis(self.scheduled_files)
        if self.scheduled_time:
            self.schedule_daily_analysis(self.scheduled_time.hour, self.scheduled_time.minute, self.scheduled_files)

    def stop_scheduler(self):
        self.timer.stop()
        self.scheduled_time = None


# ==================== УПРАВЛЕНИЕ КОЛОНКАМИ ====================

class ColumnManager:
    DEFAULT_COLUMNS = [
        "№", "MAC", "Производитель", "Модель", "IP-адрес", 
        "Физический адрес", "Помещение", "IP коммутатора", 
        "Порт подключения", "Примечание"
    ]
    
    ALL_COLUMNS = [
        "№", "MAC", "MAC (форматированный)", "OUI (3 байта)", "OUI (4 байта)",
        "OUI (5 байт)", "OUI (6 байт)", "Производитель", "Модель",
        "IP-адрес", "Физический адрес", "Помещение", "IP коммутатора",
        "Порт подключения", "Примечание", "Дата добавления"
    ]
    
    def __init__(self):
        self.visible_columns = self.DEFAULT_COLUMNS.copy()
        self.custom_columns = []
    
    def get_visible_columns(self):
        return self.visible_columns.copy()
    
    def set_visible_columns(self, columns):
        self.visible_columns = columns.copy()
    
    def add_column(self, column_name):
        if column_name not in self.visible_columns:
            self.visible_columns.append(column_name)
            return True
        return False
    
    def remove_column(self, column_name):
        if column_name in self.visible_columns and column_name != "№":
            self.visible_columns.remove(column_name)
            return True
        return False
    
    def move_up(self, column_name):
        if column_name in self.visible_columns:
            idx = self.visible_columns.index(column_name)
            if idx > 0:
                self.visible_columns[idx], self.visible_columns[idx-1] = self.visible_columns[idx-1], self.visible_columns[idx]
                return True
        return False
    
    def move_down(self, column_name):
        if column_name in self.visible_columns:
            idx = self.visible_columns.index(column_name)
            if idx < len(self.visible_columns) - 1:
                self.visible_columns[idx], self.visible_columns[idx+1] = self.visible_columns[idx+1], self.visible_columns[idx]
                return True
        return False
    
    def reset_to_default(self):
        self.visible_columns = self.DEFAULT_COLUMNS.copy()
    
    def add_custom_column(self, column_name):
        full_name = f"[Пользовательская] {column_name}"
        if full_name not in self.ALL_COLUMNS:
            self.ALL_COLUMNS.append(full_name)
            self.custom_columns.append(full_name)
            return True
        return False
    
    def remove_custom_column(self, column_name):
        if column_name in self.custom_columns:
            self.custom_columns.remove(column_name)
            if column_name in self.ALL_COLUMNS:
                self.ALL_COLUMNS.remove(column_name)
            if column_name in self.visible_columns:
                self.visible_columns.remove(column_name)
            return True
        return False
    
    def get_custom_columns(self):
        return self.custom_columns.copy()
    
    def get_column_value(self, device, column_name, index):
        if column_name == "№":
            return str(index + 1)
        elif column_name == "MAC":
            return device.get('mac', '')
        elif column_name == "MAC (форматированный)":
            return device.get('mac_formatted', '')
        elif column_name == "OUI (3 байта)":
            oui = extract_oui(device.get('mac', ''), 3)
            return format_oui(oui, 3) if oui else ''
        elif column_name == "OUI (4 байта)":
            oui = extract_oui(device.get('mac', ''), 4)
            return format_oui(oui, 4) if oui else ''
        elif column_name == "OUI (5 байт)":
            oui = extract_oui(device.get('mac', ''), 5)
            return format_oui(oui, 5) if oui else ''
        elif column_name == "OUI (6 байт)":
            oui = extract_oui(device.get('mac', ''), 6)
            return format_oui(oui, 6) if oui else ''
        elif column_name == "Производитель":
            vendor = device.get('vendor', 'Unknown')
            confidence = device.get('vendor_confidence', 0)
            source = device.get('vendor_source', '')
            if confidence > 0 and source:
                return f"{vendor} (уверенность: {confidence:.0%})"
            return vendor
        elif column_name == "Модель":
            model = device.get('model', '')
            confidence = device.get('model_confidence', 0)
            source = device.get('model_source', '')
            if confidence > 0 and source:
                return f"{model} (уверенность: {confidence:.0%})"
            return model
        elif column_name == "IP-адрес":
            return device.get('ip', '')
        elif column_name == "Физический адрес":
            return device.get('address', '')
        elif column_name == "Помещение":
            return device.get('room', '')
        elif column_name == "IP коммутатора":
            return device.get('switch_ip', '')
        elif column_name == "Порт подключения":
            return device.get('switch_port', '')
        elif column_name == "Примечание":
            return device.get('match_details', '')
        elif column_name == "Дата добавления":
            return datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        elif column_name.startswith("[Пользовательская]"):
            custom_name = column_name.replace("[Пользовательская]", "").strip()
            return device.get('custom_fields', {}).get(custom_name, '')
        return ""


# ==================== ЭКСПОРТЕР ====================

class ExportManager:
    @staticmethod
    def export_to_excel(filename, devices, column_manager=None):
        try:
            if column_manager and column_manager.get_visible_columns():
                visible_columns = column_manager.get_visible_columns()
            else:
                visible_columns = ["№", "MAC", "Производитель", "Модель", "IP-адрес", 
                                   "Физический адрес", "Помещение", "IP коммутатора", 
                                   "Порт подключения", "Примечание"]
            
            data = []
            for i, dev in enumerate(devices):
                row = {}
                for col_name in visible_columns:
                    if col_name == "№":
                        row[col_name] = i + 1
                    elif col_name == "MAC":
                        row[col_name] = dev.get('mac', '')
                    elif col_name == "MAC (форматированный)":
                        row[col_name] = dev.get('mac_formatted', '')
                    elif col_name == "OUI (3 байта)":
                        oui = extract_oui(dev.get('mac', ''), 3)
                        row[col_name] = format_oui(oui, 3) if oui else ''
                    elif col_name == "OUI (4 байта)":
                        oui = extract_oui(dev.get('mac', ''), 4)
                        row[col_name] = format_oui(oui, 4) if oui else ''
                    elif col_name == "OUI (5 байт)":
                        oui = extract_oui(dev.get('mac', ''), 5)
                        row[col_name] = format_oui(oui, 5) if oui else ''
                    elif col_name == "OUI (6 байт)":
                        oui = extract_oui(dev.get('mac', ''), 6)
                        row[col_name] = format_oui(oui, 6) if oui else ''
                    elif col_name == "Производитель":
                        vendor = dev.get('vendor', 'Unknown')
                        confidence = dev.get('vendor_confidence', 0)
                        if confidence > 0:
                            row[col_name] = f"{vendor} ({confidence:.0%})"
                        else:
                            row[col_name] = vendor
                    elif col_name == "Модель":
                        model = dev.get('model', '')
                        confidence = dev.get('model_confidence', 0)
                        if confidence > 0:
                            row[col_name] = f"{model} ({confidence:.0%})"
                        else:
                            row[col_name] = model
                    elif col_name == "IP-адрес":
                        row[col_name] = dev.get('ip', '')
                    elif col_name == "Физический адрес":
                        row[col_name] = dev.get('address', '')
                    elif col_name == "Помещение":
                        row[col_name] = dev.get('room', '')
                    elif col_name == "IP коммутатора":
                        row[col_name] = dev.get('switch_ip', '')
                    elif col_name == "Порт подключения":
                        row[col_name] = dev.get('switch_port', '')
                    elif col_name == "Примечание":
                        row[col_name] = dev.get('match_details', '')
                    elif col_name == "Дата добавления":
                        row[col_name] = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                    elif col_name.startswith("[Пользовательская]"):
                        custom_name = col_name.replace("[Пользовательская]", "").strip()
                        row[col_name] = dev.get('custom_fields', {}).get(custom_name, '')
                    else:
                        row[col_name] = ''
                data.append(row)
            
            if data:
                df = pd.DataFrame(data)
                df.to_excel(filename, index=False, sheet_name='Устройства', engine='openpyxl')
                return True
            return False
        except Exception as e:
            logging.error(f"Ошибка экспорта в Excel: {e}")
            return False

    @staticmethod
    def export_to_csv(filename, devices, column_manager=None):
        try:
            if column_manager and column_manager.get_visible_columns():
                visible_columns = column_manager.get_visible_columns()
            else:
                visible_columns = ["№", "MAC", "Производитель", "Модель", "IP-адрес", 
                                   "Физический адрес", "Помещение", "IP коммутатора", 
                                   "Порт подключения", "Примечание"]
            
            with open(filename, 'w', newline='', encoding='utf-8-sig') as f:
                writer = csv.writer(f)
                writer.writerow(visible_columns)
                for i, dev in enumerate(devices):
                    row = []
                    for col_name in visible_columns:
                        if col_name == "№":
                            row.append(i + 1)
                        elif col_name == "MAC":
                            row.append(dev.get('mac', ''))
                        elif col_name == "MAC (форматированный)":
                            row.append(dev.get('mac_formatted', ''))
                        elif col_name == "OUI (3 байта)":
                            oui = extract_oui(dev.get('mac', ''), 3)
                            row.append(format_oui(oui, 3) if oui else '')
                        elif col_name == "OUI (4 байта)":
                            oui = extract_oui(dev.get('mac', ''), 4)
                            row.append(format_oui(oui, 4) if oui else '')
                        elif col_name == "OUI (5 байт)":
                            oui = extract_oui(dev.get('mac', ''), 5)
                            row.append(format_oui(oui, 5) if oui else '')
                        elif col_name == "OUI (6 байт)":
                            oui = extract_oui(dev.get('mac', ''), 6)
                            row.append(format_oui(oui, 6) if oui else '')
                        elif col_name == "Производитель":
                            vendor = dev.get('vendor', 'Unknown')
                            confidence = dev.get('vendor_confidence', 0)
                            if confidence > 0:
                                row.append(f"{vendor} ({confidence:.0%})")
                            else:
                                row.append(vendor)
                        elif col_name == "Модель":
                            model = dev.get('model', '')
                            confidence = dev.get('model_confidence', 0)
                            if confidence > 0:
                                row.append(f"{model} ({confidence:.0%})")
                            else:
                                row.append(model)
                        elif col_name == "IP-адрес":
                            row.append(dev.get('ip', ''))
                        elif col_name == "Физический адрес":
                            row.append(dev.get('address', ''))
                        elif col_name == "Помещение":
                            row.append(dev.get('room', ''))
                        elif col_name == "IP коммутатора":
                            row.append(dev.get('switch_ip', ''))
                        elif col_name == "Порт подключения":
                            row.append(dev.get('switch_port', ''))
                        elif col_name == "Примечание":
                            row.append(dev.get('match_details', ''))
                        elif col_name == "Дата добавления":
                            row.append(datetime.now().strftime('%Y-%m-%d %H:%M:%S'))
                        elif col_name.startswith("[Пользовательская]"):
                            custom_name = col_name.replace("[Пользовательская]", "").strip()
                            row.append(dev.get('custom_fields', {}).get(custom_name, ''))
                        else:
                            row.append('')
                    writer.writerow(row)
            return True
        except Exception as e:
            logging.error(f"Ошибка экспорта в CSV: {e}")
            return False

    @staticmethod
    def export_to_txt(devices, filename, column_manager=None):
        try:
            if column_manager and column_manager.get_visible_columns():
                visible_columns = column_manager.get_visible_columns()
            else:
                visible_columns = ["№", "MAC", "Производитель", "Модель", "IP-адрес", 
                                   "Физический адрес", "Помещение", "IP коммутатора", 
                                   "Порт подключения", "Примечание"]
            
            with open(filename, 'w', encoding='utf-8-sig') as f:
                f.write("=" * 100 + "\n")
                f.write("ОТЧЕТ MAC ANALYZER PRO\n")
                f.write(f"Дата: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
                f.write(f"Всего устройств: {len(devices)}\n")
                f.write(f"Колонки: {', '.join(visible_columns)}\n")
                f.write("=" * 100 + "\n\n")
                for i, dev in enumerate(devices, 1):
                    f.write(f"[{i}]\n")
                    for col_name in visible_columns:
                        if col_name == "№":
                            continue
                        elif col_name == "MAC":
                            value = dev.get('mac', '')
                        elif col_name == "MAC (форматированный)":
                            value = dev.get('mac_formatted', '')
                        elif col_name == "OUI (3 байта)":
                            oui = extract_oui(dev.get('mac', ''), 3)
                            value = format_oui(oui, 3) if oui else ''
                        elif col_name == "OUI (4 байта)":
                            oui = extract_oui(dev.get('mac', ''), 4)
                            value = format_oui(oui, 4) if oui else ''
                        elif col_name == "OUI (5 байт)":
                            oui = extract_oui(dev.get('mac', ''), 5)
                            value = format_oui(oui, 5) if oui else ''
                        elif col_name == "OUI (6 байт)":
                            oui = extract_oui(dev.get('mac', ''), 6)
                            value = format_oui(oui, 6) if oui else ''
                        elif col_name == "Производитель":
                            vendor = dev.get('vendor', 'Unknown')
                            confidence = dev.get('vendor_confidence', 0)
                            if confidence > 0:
                                value = f"{vendor} (уверенность: {confidence:.0%})"
                            else:
                                value = vendor
                        elif col_name == "Модель":
                            model = dev.get('model', '')
                            confidence = dev.get('model_confidence', 0)
                            if confidence > 0:
                                value = f"{model} (уверенность: {confidence:.0%})"
                            else:
                                value = model
                        elif col_name == "IP-адрес":
                            value = dev.get('ip', '')
                        elif col_name == "Физический адрес":
                            value = dev.get('address', '')
                        elif col_name == "Помещение":
                            value = dev.get('room', '')
                        elif col_name == "IP коммутатора":
                            value = dev.get('switch_ip', '')
                        elif col_name == "Порт подключения":
                            value = dev.get('switch_port', '')
                        elif col_name == "Примечание":
                            value = dev.get('match_details', '')
                        elif col_name == "Дата добавления":
                            value = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                        elif col_name.startswith("[Пользовательская]"):
                            custom_name = col_name.replace("[Пользовательская]", "").strip()
                            value = dev.get('custom_fields', {}).get(custom_name, '')
                        else:
                            value = ''
                        if value:
                            f.write(f"    {col_name}: {value}\n")
                    f.write("-" * 40 + "\n")
            return True
        except Exception as e:
            logging.error(f"Ошибка экспорта в TXT: {e}")
            return False

    @staticmethod
    def export_to_html(filename, devices, column_manager=None):
        try:
            if column_manager and column_manager.get_visible_columns():
                visible_columns = column_manager.get_visible_columns()
            else:
                visible_columns = ["№", "MAC", "Производитель", "Модель", "IP-адрес", 
                                   "Физический адрес", "Помещение", "IP коммутатора", 
                                   "Порт подключения", "Примечание"]
            
            html = '''<!DOCTYPE html><html><head><meta charset="UTF-8">
            <title>MAC Analyzer Pro - Отчет</title><style>
            body { font-family: Arial, sans-serif; margin: 20px; background-color: #f5f5f5; }
            h1 { color: #3498db; } table { border-collapse: collapse; width: 100%; background-color: white; }
            th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
            th { background-color: #3498db; color: white; }
            tr:nth-child(even) { background-color: #f2f2f2; }
            .stats { background-color: white; padding: 15px; margin-bottom: 20px; border-radius: 5px; }
            .confidence-high { color: green; }
            .confidence-medium { color: orange; }
            .confidence-low { color: red; }
            </style></head><body>
            <h1>MAC Analyzer Pro - Отчет об анализе</h1>
            <div class="stats"><h2>Статистика</h2>
            <p>Всего устройств: {total}</p><p>Дата создания: {date}</p>
            <p>Колонки: {columns}</p></div>
            <table border="1">
            <thead>
            <tr>'''
            
            for col in visible_columns:
                html += f"<th>{col}</th>"
            html += "</tr>\n</thead>\n<tbody>\n"
            
            for i, dev in enumerate(devices, 1):
                html += "<tr>\n"
                for col_name in visible_columns:
                    if col_name == "№":
                        value = str(i)
                    elif col_name == "MAC":
                        value = dev.get('mac', '')
                    elif col_name == "MAC (форматированный)":
                        value = dev.get('mac_formatted', '')
                    elif col_name == "OUI (3 байта)":
                        oui = extract_oui(dev.get('mac', ''), 3)
                        value = format_oui(oui, 3) if oui else ''
                    elif col_name == "OUI (4 байта)":
                        oui = extract_oui(dev.get('mac', ''), 4)
                        value = format_oui(oui, 4) if oui else ''
                    elif col_name == "OUI (5 байт)":
                        oui = extract_oui(dev.get('mac', ''), 5)
                        value = format_oui(oui, 5) if oui else ''
                    elif col_name == "OUI (6 байт)":
                        oui = extract_oui(dev.get('mac', ''), 6)
                        value = format_oui(oui, 6) if oui else ''
                    elif col_name == "Производитель":
                        vendor = dev.get('vendor', 'Unknown')
                        confidence = dev.get('vendor_confidence', 0)
                        if confidence > 0:
                            value = f"{vendor} ({confidence:.0%})"
                        else:
                            value = vendor
                    elif col_name == "Модель":
                        model = dev.get('model', '')
                        confidence = dev.get('model_confidence', 0)
                        if confidence > 0:
                            value = f"{model} ({confidence:.0%})"
                        else:
                            value = model
                    elif col_name == "IP-адрес":
                        value = dev.get('ip', '')
                    elif col_name == "Физический адрес":
                        value = dev.get('address', '')
                    elif col_name == "Помещение":
                        value = dev.get('room', '')
                    elif col_name == "IP коммутатора":
                        value = dev.get('switch_ip', '')
                    elif col_name == "Порт подключения":
                        value = dev.get('switch_port', '')
                    elif col_name == "Примечание":
                        value = dev.get('match_details', '')
                    elif col_name == "Дата добавления":
                        value = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                    elif col_name.startswith("[Пользовательская]"):
                        custom_name = col_name.replace("[Пользовательская]", "").strip()
                        value = dev.get('custom_fields', {}).get(custom_name, '')
                    else:
                        value = ''
                    html += f"<td>{value}</td>\n"
                html += "</tr>\n"
            
            html += f"</tbody>\n</table>\n</body>\n</html>"
            html = html.format(total=len(devices), date=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                               columns=', '.join(visible_columns))
            with open(filename, 'w', encoding='utf-8') as f:
                f.write(html)
            return True
        except Exception as e:
            logging.error(f"Ошибка экспорта в HTML: {e}")
            return False

    @staticmethod
    def export_to_pdf_chunked(filename, devices, column_manager=None, max_per_page=50):
        if not PDF_AVAILABLE:
            return False
        try:
            if column_manager and column_manager.get_visible_columns():
                visible_columns = column_manager.get_visible_columns()
            else:
                visible_columns = ["№", "MAC", "Производитель", "Модель", "IP-адрес", 
                                   "Физический адрес", "Помещение", "IP коммутатора", 
                                   "Порт подключения", "Примечание"]
            
            doc = SimpleDocTemplate(filename, pagesize=landscape(A4))
            elements = []
            styles = getSampleStyleSheet()
            title_style = ParagraphStyle('CustomTitle', parent=styles['Title'], fontSize=16)
            title = Paragraph("MAC Analyzer Pro - Отчет", title_style)
            elements.append(title)
            elements.append(Spacer(1, 0.2 * inch))
            date = Paragraph(f"Дата: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}", styles['Normal'])
            elements.append(date)
            elements.append(Spacer(1, 0.2 * inch))
            
            total_pages = (len(devices) + max_per_page - 1) // max_per_page
            for page_num in range(total_pages):
                start_idx = page_num * max_per_page
                end_idx = min(start_idx + max_per_page, len(devices))
                page_devices = devices[start_idx:end_idx]
                
                page_header = Paragraph(f"Страница {page_num + 1} из {total_pages}", styles['Normal'])
                elements.append(page_header)
                elements.append(Spacer(1, 0.1 * inch))
                
                table_data = [visible_columns.copy()]
                for i, dev in enumerate(page_devices, start_idx + 1):
                    row = []
                    for col_name in visible_columns:
                        if col_name == "№":
                            row.append(str(i))
                        elif col_name == "MAC":
                            row.append(dev.get('mac', '')[:20])
                        elif col_name == "MAC (форматированный)":
                            row.append(dev.get('mac_formatted', '')[:20])
                        elif col_name == "OUI (3 байта)":
                            oui = extract_oui(dev.get('mac', ''), 3)
                            row.append(format_oui(oui, 3)[:15] if oui else '')
                        elif col_name in ["Производитель", "Модель", "IP-адрес", "Физический адрес", 
                                          "Помещение", "IP коммутатора", "Порт подключения", "Примечание"]:
                            val_map = {
                                "Производитель": dev.get('vendor', ''),
                                "Модель": dev.get('model', ''),
                                "IP-адрес": dev.get('ip', ''),
                                "Физический адрес": dev.get('address', ''),
                                "Помещение": dev.get('room', ''),
                                "IP коммутатора": dev.get('switch_ip', ''),
                                "Порт подключения": dev.get('switch_port', ''),
                                "Примечание": dev.get('match_details', '')
                            }
                            row.append(val_map.get(col_name, '')[:30])
                        else:
                            row.append('')
                    table_data.append(row)
                
                table = Table(table_data)
                table.setStyle(TableStyle([
                    ('BACKGROUND', (0, 0), (-1, 0), colors.grey),
                    ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
                    ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
                    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                    ('FONTSIZE', (0, 0), (-1, 0), 8),
                    ('BOTTOMPADDING', (0, 0), (-1, 0), 12),
                    ('GRID', (0, 0), (-1, -1), 1, colors.black),
                    ('FONTSIZE', (0, 1), (-1, -1), 7)
                ]))
                elements.append(table)
                
                if page_num < total_pages - 1:
                    elements.append(PageBreak())
            
            doc.build(elements)
            return True
        except Exception as e:
            logging.error(f"Ошибка PDF экспорта: {e}")
            return False

    @staticmethod
    def export_to_pdf(filename, devices, column_manager=None):
        return ExportManager.export_to_pdf_chunked(filename, devices, column_manager)

    @staticmethod
    def export_to_json(filename, devices, column_manager=None):
        try:
            export_data = {
                'export_date': datetime.now().isoformat(),
                'total_devices': len(devices),
                'version': '9.0',
                'devices': devices
            }
            with open(filename, 'w', encoding='utf-8') as f:
                json.dump(export_data, f, ensure_ascii=False, indent=2)
            return True
        except Exception as e:
            logging.error(f"Ошибка экспорта в JSON: {e}")
            return False

    @staticmethod
    def export_to_yaml(filename, devices, column_manager=None):
        if not YAML_AVAILABLE:
            return False
        try:
            export_data = {
                'export_date': datetime.now().isoformat(),
                'total_devices': len(devices),
                'version': '9.0',
                'devices': devices
            }
            with open(filename, 'w', encoding='utf-8') as f:
                yaml.dump(export_data, f, allow_unicode=True, default_flow_style=False, sort_keys=False)
            return True
        except Exception as e:
            logging.error(f"Ошибка экспорта в YAML: {e}")
            return False


# ==================== КЛАСС MACAnalyzer ====================

class MACAnalyzer:
    def __init__(self):
        self.vendor_db = VendorDatabase()
        self.memory_monitor = MemoryMonitor()
        self.validator = MACValidator()

    def normalize_mac(self, mac):
        return self.validator.normalize(mac)

    def format_mac(self, mac):
        return self.validator.format_mac(mac)

    @cached(maxsize=1000)
    def get_vendor(self, mac):
        if not mac or len(mac) < 6:
            return 'Unknown'
        return self.vendor_db.get_vendor_by_oui(mac[:6])

    def get_column_index(self, col_spec, headers, has_headers):
        if not col_spec or col_spec == 'Не указано':
            return None
        
        if re.match(r'^[A-Za-z]+$', col_spec):
            col_spec = col_spec.upper()
            index = 0
            for char in col_spec:
                index = index * 26 + (ord(char) - ord('A') + 1)
            return index - 1
        
        if has_headers and headers:
            for i, header in enumerate(headers):
                if header and header.lower() == col_spec.lower():
                    return i
        
        return None

    def _process_chunk(self, chunk_df: pd.DataFrame, column_mapping: dict, start_index: int, progress_callback=None) -> Tuple[List[dict], List[str]]:
        devices = []
        errors = []
        
        has_headers = column_mapping.get('has_headers', False)
        headers = column_mapping.get('headers', [])
        
        mac_col = column_mapping.get('mac_col', 'A')
        vendor_col = column_mapping.get('vendor_col')
        model_col = column_mapping.get('model_col')
        address_col = column_mapping.get('address_col')
        ip_col = column_mapping.get('ip_col')
        room_col = column_mapping.get('room_col')
        switch_ip_col = column_mapping.get('switch_ip_col')
        switch_port_col = column_mapping.get('switch_port_col')
        
        mac_idx = self.get_column_index(mac_col, headers, has_headers)
        if mac_idx is None:
            mac_idx = 0
        
        vendor_idx = self.get_column_index(vendor_col, headers, has_headers) if vendor_col else None
        model_idx = self.get_column_index(model_col, headers, has_headers) if model_col else None
        address_idx = self.get_column_index(address_col, headers, has_headers) if address_col else None
        ip_idx = self.get_column_index(ip_col, headers, has_headers) if ip_col else None
        room_idx = self.get_column_index(room_col, headers, has_headers) if room_col else None
        switch_ip_idx = self.get_column_index(switch_ip_col, headers, has_headers) if switch_ip_col else None
        switch_port_idx = self.get_column_index(switch_port_col, headers, has_headers) if switch_port_col else None
        
        custom_fields = column_mapping.get('custom_fields', [])
        custom_idxs = {}
        for field_name, display_name in custom_fields:
            col_spec = column_mapping.get(field_name)
            if col_spec:
                idx = self.get_column_index(col_spec, headers, has_headers)
                if idx is not None:
                    custom_idxs[field_name] = (idx, display_name)
        
        total_rows = len(chunk_df)
        for idx, row in chunk_df.iterrows():
            if progress_callback and idx % 1000 == 0:
                progress_callback(start_index + idx, total_rows)
            
            if len(row) <= mac_idx:
                continue
            
            mac_val = row[mac_idx]
            if pd.isna(mac_val) or not mac_val:
                continue
            
            mac = self.normalize_mac(mac_val)
            if mac:
                device = {
                    'row': start_index + idx + 1,
                    'mac': mac,
                    'mac_formatted': self.format_mac(mac),
                    'oui': mac[:6] if len(mac) >= 6 else None,
                    'vendor': self.get_vendor(mac),
                    'model': '',
                    'address': '',
                    'ip': '',
                    'room': '',
                    'switch_ip': '',
                    'switch_port': '',
                    'confidence': 100,
                    'match_details': 'Данные из основного файла',
                    'custom_fields': {}
                }
                
                # Приоритет: данные из файла имеют наивысший приоритет
                if vendor_idx is not None and vendor_idx < len(row) and not pd.isna(row[vendor_idx]):
                    vendor_val = str(row[vendor_idx]).strip()
                    if vendor_val and vendor_val != 'nan':
                        device['vendor'] = vendor_val
                        device['vendor_source'] = 'Из файла'
                        device['vendor_confidence'] = 1.0
                
                if model_idx is not None and model_idx < len(row) and not pd.isna(row[model_idx]):
                    model_val = str(row[model_idx]).strip()
                    if model_val and model_val != 'nan':
                        device['model'] = model_val
                        device['model_source'] = 'Из файла'
                        device['model_confidence'] = 1.0
                
                if address_idx is not None and address_idx < len(row) and not pd.isna(row[address_idx]):
                    address_val = str(row[address_idx]).strip()
                    if address_val and address_val != 'nan':
                        device['address'] = address_val
                
                if ip_idx is not None and ip_idx < len(row) and not pd.isna(row[ip_idx]):
                    ip_val = str(row[ip_idx]).strip()
                    if ip_val and ip_val != 'nan':
                        device['ip'] = ip_val
                
                if room_idx is not None and room_idx < len(row) and not pd.isna(row[room_idx]):
                    room_val = str(row[room_idx]).strip()
                    if room_val and room_val != 'nan':
                        device['room'] = room_val
                
                if switch_ip_idx is not None and switch_ip_idx < len(row) and not pd.isna(row[switch_ip_idx]):
                    switch_ip_val = str(row[switch_ip_idx]).strip()
                    if switch_ip_val and switch_ip_val != 'nan':
                        device['switch_ip'] = switch_ip_val
                
                if switch_port_idx is not None and switch_port_idx < len(row) and not pd.isna(row[switch_port_idx]):
                    switch_port_val = str(row[switch_port_idx]).strip()
                    if switch_port_val and switch_port_val != 'nan':
                        device['switch_port'] = switch_port_val
                
                for field_name, (col_idx, display_name) in custom_idxs.items():
                    if col_idx < len(row) and not pd.isna(row[col_idx]):
                        val = str(row[col_idx]).strip()
                        if val and val != 'nan':
                            device['custom_fields'][display_name] = val
                
                devices.append(device)
            else:
                errors.append(f"Строка {start_index + idx + 1}: неверный MAC '{mac_val}'")
        
        self.memory_monitor.optimize_if_needed()
        
        return devices, errors

    def read_excel_chunked(self, filename: str, sheet_name: int = 0, column_mapping: dict = None, 
                          chunk_size: int = 10000, progress_callback=None) -> Tuple[List[dict], List[str]]:
        try:
            all_devices = []
            all_errors = []
            
            if filename.endswith('.csv'):
                total_chunks = None
                for chunk_num, chunk in enumerate(pd.read_csv(filename, encoding='utf-8', dtype=str, chunksize=chunk_size)):
                    if progress_callback:
                        progress_callback(chunk_num * chunk_size, chunk_size)
                    chunk_devices, chunk_errors = self._process_chunk(chunk, column_mapping, len(all_devices), progress_callback)
                    all_devices.extend(chunk_devices)
                    all_errors.extend(chunk_errors)
                    self.memory_monitor.optimize_if_needed()
            else:
                df, error = safe_load_file(filename)
                if df is None:
                    return None, [error]
                
                if df.empty or len(df.columns) == 0:
                    return [], ["Файл пуст или не содержит данных"]
                
                has_headers = column_mapping.get('has_headers', False) if column_mapping else False
                headers = column_mapping.get('headers', []) if column_mapping else []
                
                if not has_headers and len(df) > 0:
                    first_row = df.iloc[0]
                    header_candidates = [str(v).strip() for v in first_row if not pd.isna(v)]
                    is_header_row = True
                    for val in header_candidates[:5]:
                        if val and re.match(r'^([0-9A-F]{2}[:-]){5}[0-9A-F]{2}$', val.upper(), re.IGNORECASE):
                            is_header_row = False
                            break
                        if val and re.match(r'^[0-9A-F]{12}$', val.upper()):
                            is_header_row = False
                            break
                    
                    if is_header_row and header_candidates:
                        has_headers = True
                        headers = [str(h).strip() if not pd.isna(h) else get_column_letter(i) for i, h in enumerate(first_row)]
                        df = df.iloc[1:]
                        df = df.reset_index(drop=True)
                
                if column_mapping:
                    column_mapping['has_headers'] = has_headers
                    column_mapping['headers'] = headers
                
                total_rows = len(df)
                for start_idx in range(0, total_rows, chunk_size):
                    if progress_callback:
                        progress_callback(start_idx, total_rows)
                    chunk = df.iloc[start_idx:start_idx + chunk_size]
                    chunk_devices, chunk_errors = self._process_chunk(chunk, column_mapping, start_idx, progress_callback)
                    all_devices.extend(chunk_devices)
                    all_errors.extend(chunk_errors)
                    self.memory_monitor.optimize_if_needed()
            
            return all_devices, all_errors
            
        except Exception as e:
            logging.error(f"Ошибка чтения файла {filename}: {e}")
            return None, [str(e)]


# ==================== ОБОГАТИТЕЛЬ ДАННЫХ ====================

class DataEnricher:
    def __init__(self):
        self.files = {}
        self.primary_alias = None
        self.primary_devices = []
        self.additional_devices = []
        self.row_strategy = "keep_primary_only"
        self.comparison_fields = {'mac': True, 'oui': True, 'vendor': False, 'model': False,
                                   'ip': False, 'address': False, 'room': False,
                                   'switch_ip': False, 'switch_port': False}
        self.comparison_threshold = 70
        self.enrich_fields = {'model': True, 'address': True, 'ip': True, 'vendor': True, 
                               'room': True, 'switch_ip': True, 'switch_port': True}
        self.oui_formats = {3: True, 4: False, 5: False, 6: False}
        self.enrichment_log = []
        self._index_cache = {}
        self.ip_address_mapper = IPToAddressMapper()
        self.vendor_detector = VendorDetector()
        self.history_enricher = HistoryEnricher()
        self.mac_history_db = MACHistoryDatabase()

    def add_file(self, filepath, alias=None, is_primary=False):
        if not os.path.exists(filepath):
            return False
        if alias is None:
            alias = Path(filepath).stem
        self.files[alias] = {'path': filepath, 'devices': [], 'is_primary': is_primary, 'mapping': {}}
        if is_primary:
            self.primary_alias = alias
        return True

    def set_mapping(self, alias, mapping):
        if alias in self.files:
            self.files[alias]['mapping'] = mapping

    def set_row_strategy(self, strategy):
        self.row_strategy = strategy

    def set_comparison_fields(self, fields, threshold):
        self.comparison_fields = fields
        self.comparison_threshold = threshold

    def set_enrich_fields(self, fields):
        self.enrich_fields = fields

    def set_oui_formats(self, formats):
        self.oui_formats = formats

    def load_file(self, alias, analyzer, sheet=0, progress_callback=None):
        if alias not in self.files:
            return False
        filepath = self.files[alias]['path']
        if not os.path.exists(filepath):
            return False
        mapping = self.files[alias].get('mapping', {})
        devices, errors = analyzer.read_excel_chunked(filepath, sheet, mapping, progress_callback=progress_callback)
        if devices is not None:
            self.files[alias]['devices'] = devices
            if self.files[alias]['is_primary']:
                self.primary_devices = devices
            else:
                self.additional_devices.extend(devices)
            return True
        return False

    def load_ip_address_mapping(self, filepath: str, ip_col: str = None, address_col: str = None) -> int:
        return self.ip_address_mapper.load_mapping_from_file(filepath, ip_col, address_col)
    
    def auto_detect_ip_address_mapping(self) -> int:
        all_devices = self.primary_devices + self.additional_devices
        return self.ip_address_mapper.auto_detect_from_devices(all_devices)
    
    def set_ip_enrichment_settings(self, enabled: bool = None, partial_match: bool = None, overwrite: bool = None):
        self.ip_address_mapper.set_settings(enabled, partial_match, overwrite)
    
    def set_vendor_detector_settings(self, enabled: bool = None, use_oui_3byte: bool = None,
                                      use_oui_5byte: bool = None, use_text: bool = None,
                                      use_inference: bool = None, confidence_threshold: float = None):
        if enabled is not None:
            self.vendor_detector.enabled = enabled
        if use_oui_3byte is not None:
            self.vendor_detector.use_oui_3byte = use_oui_3byte
        if use_oui_5byte is not None:
            self.vendor_detector.use_oui_5byte = use_oui_5byte
        if use_text is not None:
            self.vendor_detector.use_text_analysis = use_text
        if use_inference is not None:
            self.vendor_detector.use_inference = use_inference
        if confidence_threshold is not None:
            self.vendor_detector.confidence_threshold = confidence_threshold
    
    def set_history_enrichment_settings(self, enabled: bool = None, priority_history: bool = None,
                                        use_oui_match: bool = None, use_mac5_match: bool = None):
        self.history_enricher.set_settings(enabled, priority_history, use_oui_match, use_mac5_match)
    
    def get_history_stats(self) -> dict:
        return self.history_enricher.get_stats()
    
    def save_scan_to_history(self, devices: List[dict], filename: str):
        self.mac_history_db.add_devices_batch(devices, filename)
        return self.history_enricher.save_scan_to_history(devices, filename)
    
    def enrich_from_history(self, devices: List[dict]) -> Tuple[List[dict], dict]:
        return self.history_enricher.enrich_devices_from_history(devices)
    
    def add_custom_mac5_mapping(self, prefix_5byte: str, model: str) -> bool:
        return self.vendor_detector.add_custom_mac5_mapping(prefix_5byte, model)
    
    def enrich_devices(self, devices: List[dict]) -> Tuple[List[dict], dict]:
        return self.vendor_detector.enrich_devices(devices)
    
    def enrich_address_by_ip(self, devices: List[dict]) -> List[dict]:
        enriched_count = 0
        
        for dev in devices:
            switch_ip = dev.get('switch_ip', '')
            current_address = dev.get('address', '')
            
            if not switch_ip or not validate_ip(switch_ip):
                continue
            
            # Если адрес уже есть из файла - не перезаписываем
            if current_address and current_address not in ['Unknown', '', 'Не указано']:
                if not self.ip_address_mapper.overwrite_existing:
                    continue
            
            address = self.ip_address_mapper.get_address_by_ip(switch_ip, use_partial_match=True)
            
            if address:
                dev['address'] = address
                dev['address_source'] = 'ip_mapping'
                dev['match_details'] = dev.get('match_details', '') + f"; Адрес определен по IP {switch_ip}"
                enriched_count += 1
        
        return devices
    
    def get_ip_mapping_stats(self) -> dict:
        return self.ip_address_mapper.get_stats()
    
    def get_vendor_detector_stats(self) -> dict:
        return self.vendor_detector.get_stats()
    
    def export_ip_mappings(self, filename: str, format_type: str = 'excel') -> bool:
        return self.ip_address_mapper.export_mappings(filename, format_type)
    
    def get_mac_history(self, mac: str) -> List[dict]:
        return self.mac_history_db.get_mac_history(mac)
    
    def get_mac_movements(self, mac: str) -> List[dict]:
        return self.mac_history_db.get_mac_movements(mac)
    
    def get_mac_statistics(self, mac: str) -> dict:
        return self.mac_history_db.get_mac_statistics(mac)
    
    def search_macs(self, search_term: str) -> List[dict]:
        return self.mac_history_db.search_by_mac(search_term)
    
    def search_all(self, search_term: str) -> List[dict]:
        return self.mac_history_db.search_all(search_term)

    def _device_weight(self, dev):
        weight = 0
        for field in ['vendor', 'model', 'address', 'ip', 'room', 'switch_ip', 'switch_port']:
            if dev.get(field) and dev[field] not in ['Unknown', 'Не указано', None, '']:
                weight += 1
        return weight

    def _merge_device(self, target, source, source_name=""):
        """Объединение данных с учетом приоритета (данные из файла имеют наивысший приоритет)"""
        result = target.copy()
        
        # ВАЖНО: данные из файла (target) имеют приоритет над source
        # Обогащаем ТОЛЬКО если в target нет значения или значение не заполнено
        
        if self.enrich_fields.get('address', True):
            if source.get('address') and source['address'] not in ['Unknown', None, '']:
                if not result.get('address') or result['address'] in [None, 'Unknown', '', 'Не указано']:
                    result['address'] = source['address']
        
        if self.enrich_fields.get('room', True):
            if source.get('room') and source['room'] not in ['Unknown', 'Не указано', None, '']:
                if not result.get('room') or result['room'] in [None, 'Unknown', 'Не указано', '']:
                    result['room'] = source['room']
        
        if self.enrich_fields.get('model', True):
            if source.get('model') and source['model'] not in ['Unknown', None, '']:
                if not result.get('model') or result['model'] in [None, 'Unknown', '']:
                    result['model'] = source['model']
                    result['model_source'] = source.get('model_source', source_name)
                    result['model_confidence'] = source.get('model_confidence', 0.5)
        
        if self.enrich_fields.get('ip', True):
            if source.get('ip') and source['ip'] not in ['Unknown', None, '']:
                if not result.get('ip') or result['ip'] in [None, 'Unknown', '']:
                    result['ip'] = source['ip']
        
        if self.enrich_fields.get('vendor', True):
            if source.get('vendor') and source['vendor'] != 'Unknown':
                if not result.get('vendor') or result['vendor'] in [None, 'Unknown', '']:
                    result['vendor'] = source['vendor']
                    result['vendor_source'] = source.get('vendor_source', source_name)
                    result['vendor_confidence'] = source.get('vendor_confidence', 0.5)
        
        if self.enrich_fields.get('switch_ip', True):
            if source.get('switch_ip') and source['switch_ip'] not in ['Unknown', None, '']:
                if not result.get('switch_ip') or result['switch_ip'] in [None, 'Unknown', '']:
                    result['switch_ip'] = source['switch_ip']
        
        if self.enrich_fields.get('switch_port', True):
            if source.get('switch_port') and source['switch_port'] not in ['Unknown', None, '']:
                if not result.get('switch_port') or result['switch_port'] in [None, 'Unknown', '']:
                    result['switch_port'] = source['switch_port']
        
        if 'custom_fields' not in result:
            result['custom_fields'] = {}
        for field_name, value in source.get('custom_fields', {}).items():
            if value:
                if field_name not in result['custom_fields'] or not result['custom_fields'][field_name]:
                    result['custom_fields'][field_name] = value
        
        return result

    def _compare_devices(self, dev1, dev2):
        score = 0
        total = 0
        
        if self.comparison_fields.get('mac', True):
            total += 100
            if dev1.get('mac') == dev2.get('mac'):
                score += 100
        
        if self.comparison_fields.get('oui', True):
            total += 100
            oui1 = dev1.get('oui', '')[:6] if dev1.get('oui') else ''
            oui2 = dev2.get('oui', '')[:6] if dev2.get('oui') else ''
            if oui1 and oui2 and oui1 == oui2:
                score += 100
        
        if self.comparison_fields.get('vendor', False):
            total += 50
            if dev1.get('vendor') == dev2.get('vendor') and dev1.get('vendor') != 'Unknown':
                score += 50
        
        if self.comparison_fields.get('model', False):
            total += 50
            if dev1.get('model') == dev2.get('model') and dev1.get('model'):
                score += 50
        
        if self.comparison_fields.get('ip', False):
            total += 50
            if dev1.get('ip') == dev2.get('ip') and dev1.get('ip'):
                score += 50
        
        if self.comparison_fields.get('address', False):
            total += 50
            if dev1.get('address') == dev2.get('address') and dev1.get('address'):
                score += 50
        
        if self.comparison_fields.get('room', False):
            total += 50
            if dev1.get('room') == dev2.get('room') and dev1.get('room'):
                score += 50
        
        if self.comparison_fields.get('switch_ip', False):
            total += 50
            if dev1.get('switch_ip') == dev2.get('switch_ip') and dev1.get('switch_ip'):
                score += 50
        
        if self.comparison_fields.get('switch_port', False):
            total += 50
            if dev1.get('switch_port') == dev2.get('switch_port') and dev1.get('switch_port'):
                score += 50
        
        if total == 0:
            return 0
        
        return (score / total) * 100

    def _build_index(self, devices: List[dict]) -> Dict[str, dict]:
        index = {}
        for dev in devices:
            mac = dev.get('mac')
            if mac:
                if mac in index:
                    if self._device_weight(dev) > self._device_weight(index[mac]):
                        index[mac] = dev
                else:
                    index[mac] = dev
        return index

    def enrich_fast(self) -> List[dict]:
        result = []
        
        primary_index = self._build_index(self.primary_devices)
        additional_index = self._build_index(self.additional_devices)
        
        for mac, primary in primary_index.items():
            enriched = primary.copy()
            if mac in additional_index:
                enriched = self._merge_device(enriched, additional_index[mac], "дополнительный файл")
                enriched['match_details'] = enriched.get('match_details', '') + " + Обогащено (совпадение MAC)"
            else:
                best_match = None
                best_score = 0
                for add_mac, add_dev in additional_index.items():
                    score = self._compare_devices(primary, add_dev)
                    if score >= self.comparison_threshold and score > best_score:
                        best_score = score
                        best_match = add_dev
                
                if best_match:
                    enriched = self._merge_device(enriched, best_match, "дополнительный файл")
                    enriched['match_details'] = enriched.get('match_details', '') + f" + Обогащено (совпадение {best_score:.0f}%)"
            
            result.append(enriched)
        
        if self.row_strategy == "add_new_rows":
            for mac, additional in additional_index.items():
                if mac not in primary_index:
                    new_dev = additional.copy()
                    new_dev['match_details'] = new_dev.get('match_details', '') + " (Новое устройство из дополнительного файла)"
                    result.append(new_dev)
        
        # Обогащение через детектор (только если нет данных из файла)
        if self.vendor_detector.enabled:
            result, enrich_stats = self.enrich_devices(result)
            logging.info(f"Обогащение: производителей={enrich_stats.get('enriched_vendor', 0)}, моделей={enrich_stats.get('enriched_model', 0)}")
        
        # Историческое обогащение (только если нет данных из файла)
        if self.history_enricher.enabled:
            result, history_stats = self.enrich_from_history(result)
            logging.info(f"Историческое обогащение: производителей={history_stats.get('enriched_vendor', 0)}, "
                        f"моделей={history_stats.get('enriched_model', 0)}")
        
        # IP -> адрес обогащение
        if self.ip_address_mapper.enrichment_enabled:
            result = self.enrich_address_by_ip(result)
        
        return result

    def enrich(self):
        return self.enrich_fast()


# ==================== ДИАЛОГ НАСТРОЙКИ ОПРЕДЕЛЕНИЯ ПРОИЗВОДИТЕЛЯ И МОДЕЛИ ====================

class VendorDetectorSettingsDialog(QDialog):
    def __init__(self, enricher, parent=None):
        super().__init__(parent)
        self.enricher = enricher
        self.setWindowTitle("Настройка определения производителя и модели")
        self.setModal(True)
        self.setGeometry(300, 300, 650, 550)
        self.setStyleSheet(parent.styleSheet() if parent else "")
        self.init_ui()
        self.load_settings()
    
    def init_ui(self):
        layout = QVBoxLayout()
        
        title = QLabel("🏭 Расширенное определение производителя и модели")
        title.setFont(QFont("Segoe UI", 14, QFont.Bold))
        layout.addWidget(title)
        
        info_label = QLabel(
            "Программа может определять производителя и модель устройства:\n"
            "• По 3 байтам MAC (OUI) - определяет производителя\n"
            "• По 5 байтам MAC - определяет конкретную модель (на основе базы)\n"
            "• По текстовым полям (модель, описание, имя)\n"
            "• По инференсу из похожих устройств\n"
            "• ИЗ ИСТОРИИ РАНЕЕ СКАНИРОВАННЫХ ФАЙЛОВ\n\n"
            "⚠️ ВАЖНО: Данные из файла имеют наивысший приоритет и НЕ ПЕРЕЗАПИСЫВАЮТСЯ"
        )
        info_label.setWordWrap(True)
        info_label.setStyleSheet("color: #888; padding: 5px;")
        layout.addWidget(info_label)
        
        group = QGroupBox("Настройки определения")
        group_layout = QVBoxLayout()
        
        self.enabled_cb = QCheckBox("Включить автоматическое определение")
        self.enabled_cb.setChecked(True)
        group_layout.addWidget(self.enabled_cb)
        
        self.use_oui_3byte_cb = QCheckBox("Определять производителя по 3 байтам MAC (OUI)")
        self.use_oui_3byte_cb.setChecked(True)
        group_layout.addWidget(self.use_oui_3byte_cb)
        
        self.use_oui_5byte_cb = QCheckBox("Определять модель по 5 байтам MAC (префикс)")
        self.use_oui_5byte_cb.setChecked(True)
        group_layout.addWidget(self.use_oui_5byte_cb)
        
        self.use_text_cb = QCheckBox("Определять по текстовым полям")
        self.use_text_cb.setChecked(True)
        group_layout.addWidget(self.use_text_cb)
        
        self.use_inference_cb = QCheckBox("Использовать инференс из похожих устройств")
        self.use_inference_cb.setChecked(True)
        group_layout.addWidget(self.use_inference_cb)
        
        threshold_layout = QHBoxLayout()
        threshold_layout.addWidget(QLabel("Порог уверенности:"))
        self.threshold_slider = QSlider(Qt.Horizontal)
        self.threshold_slider.setRange(0, 100)
        self.threshold_slider.setValue(60)
        self.threshold_slider.setTickInterval(10)
        threshold_layout.addWidget(self.threshold_slider)
        self.threshold_label = QLabel("60%")
        self.threshold_slider.valueChanged.connect(lambda v: self.threshold_label.setText(f"{v}%"))
        threshold_layout.addWidget(self.threshold_label)
        group_layout.addLayout(threshold_layout)
        
        group.setLayout(group_layout)
        layout.addWidget(group)
        
        custom_group = QGroupBox("Пользовательские соответствия (5 байт MAC → модель)")
        custom_layout = QVBoxLayout()
        
        custom_form = QFormLayout()
        self.custom_prefix_edit = QLineEdit()
        self.custom_prefix_edit.setPlaceholderText("0011223344 (10 символов)")
        self.custom_model_edit = QLineEdit()
        self.custom_model_edit.setPlaceholderText("Название модели")
        add_custom_btn = QPushButton("➕ Добавить")
        add_custom_btn.clicked.connect(self.add_custom_mapping)
        custom_form.addRow("Префикс MAC (5 байт):", self.custom_prefix_edit)
        custom_form.addRow("Модель:", self.custom_model_edit)
        custom_form.addRow(add_custom_btn)
        custom_layout.addLayout(custom_form)
        
        self.custom_list = QListWidget()
        self.custom_list.setMaximumHeight(150)
        custom_layout.addWidget(self.custom_list)
        
        custom_group.setLayout(custom_layout)
        layout.addWidget(custom_group)
        
        stats_group = QGroupBox("Текущая статистика")
        stats_layout = QVBoxLayout()
        self.stats_label = QLabel("")
        stats_layout.addWidget(self.stats_label)
        stats_group.setLayout(stats_layout)
        layout.addWidget(stats_group)
        
        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        buttons.accepted.connect(self.save_settings)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)
        
        self.setLayout(layout)
        self.update_stats()
        self.load_custom_mappings()
    
    def load_settings(self):
        stats = self.enricher.get_vendor_detector_stats()
        self.enabled_cb.setChecked(stats.get('enabled', True))
        self.use_oui_3byte_cb.setChecked(stats.get('use_oui_3byte', True))
        self.use_oui_5byte_cb.setChecked(stats.get('use_oui_5byte', True))
        self.use_text_cb.setChecked(stats.get('use_text_analysis', True))
        self.use_inference_cb.setChecked(stats.get('use_inference', True))
        self.threshold_slider.setValue(int(stats.get('confidence_threshold', 0.6) * 100))
    
    def save_settings(self):
        self.enricher.set_vendor_detector_settings(
            enabled=self.enabled_cb.isChecked(),
            use_oui_3byte=self.use_oui_3byte_cb.isChecked(),
            use_oui_5byte=self.use_oui_5byte_cb.isChecked(),
            use_text=self.use_text_cb.isChecked(),
            use_inference=self.use_inference_cb.isChecked(),
            confidence_threshold=self.threshold_slider.value() / 100.0
        )
        self.accept()
    
    def add_custom_mapping(self):
        prefix = self.custom_prefix_edit.text().strip().upper()
        model = self.custom_model_edit.text().strip()
        
        if len(prefix) != 10:
            QMessageBox.warning(self, "Ошибка", "Префикс MAC должен содержать 10 символов (5 байт в hex)!")
            return
        if not model:
            QMessageBox.warning(self, "Ошибка", "Введите название модели!")
            return
        
        if self.enricher.add_custom_mac5_mapping(prefix, model):
            self.custom_prefix_edit.clear()
            self.custom_model_edit.clear()
            self.load_custom_mappings()
            QMessageBox.information(self, "Успех", f"Добавлено соответствие: {prefix} → {model}")
        else:
            QMessageBox.warning(self, "Ошибка", "Не удалось добавить соответствие!")
    
    def load_custom_mappings(self):
        self.custom_list.clear()
        for prefix, model in VendorDatabase.MAC5_PREFIX_MODELS.items():
            if len(prefix) == 10:
                self.custom_list.addItem(f"{prefix} → {model}")
    
    def update_stats(self):
        stats = self.enricher.get_vendor_detector_stats()
        self.stats_label.setText(
            f"Кэш производителей: {stats['cache_size_vendor']} | "
            f"Кэш моделей: {stats['cache_size_model']} | "
            f"OUI (3 байта): {'Вкл' if stats['use_oui_3byte'] else 'Выкл'} | "
            f"MAC5 (5 байт): {'Вкл' if stats['use_oui_5byte'] else 'Выкл'}"
        )


# ==================== ДИАЛОГ НАСТРОЙКИ ИСТОРИЧЕСКОГО ОБОГАЩЕНИЯ ====================

class HistoryEnrichmentSettingsDialog(QDialog):
    def __init__(self, history_enricher: HistoryEnricher, parent=None):
        super().__init__(parent)
        self.history_enricher = history_enricher
        self.setWindowTitle("Настройка исторического обогащения")
        self.setModal(True)
        self.setGeometry(300, 300, 550, 450)
        self.setStyleSheet(parent.styleSheet() if parent else "")
        self.init_ui()
        self.load_settings()
    
    def init_ui(self):
        layout = QVBoxLayout()
        
        title = QLabel("📚 Настройка обогащения из истории")
        title.setFont(QFont("Segoe UI", 14, QFont.Bold))
        layout.addWidget(title)
        
        info_label = QLabel(
            "При включении этой функции программа будет использовать данные из ранее обработанных файлов\n"
            "для автоматического определения производителей и моделей устройств в новых файлах.\n"
            "Все данные сохраняются локально и не передаются третьим лицам.\n\n"
            "⚠️ Данные из файла имеют приоритет над историческими данными."
        )
        info_label.setWordWrap(True)
        info_label.setStyleSheet("color: #888; padding: 5px;")
        layout.addWidget(info_label)
        
        group = QGroupBox("Настройки исторического обогащения")
        group_layout = QVBoxLayout()
        
        self.enabled_cb = QCheckBox("Включить обогащение из истории")
        self.enabled_cb.setChecked(True)
        group_layout.addWidget(self.enabled_cb)
        
        self.priority_cb = QCheckBox("Приоритет истории над встроенной базой данных")
        self.priority_cb.setChecked(True)
        group_layout.addWidget(self.priority_cb)
        
        match_group = QGroupBox("Методы сопоставления")
        match_layout = QVBoxLayout()
        
        self.use_oui_cb = QCheckBox("Совпадение по OUI (3 байта MAC)")
        self.use_oui_cb.setChecked(True)
        match_layout.addWidget(self.use_oui_cb)
        
        self.use_mac5_cb = QCheckBox("Совпадение по префиксу (5 байт MAC)")
        self.use_mac5_cb.setChecked(True)
        match_layout.addWidget(self.use_mac5_cb)
        
        match_group.setLayout(match_layout)
        group_layout.addWidget(match_group)
        
        group.setLayout(group_layout)
        layout.addWidget(group)
        
        stats_group = QGroupBox("Текущая статистика истории")
        stats_layout = QVBoxLayout()
        self.stats_label = QLabel("")
        stats_layout.addWidget(self.stats_label)
        stats_group.setLayout(stats_layout)
        layout.addWidget(stats_group)
        
        view_history_btn = QPushButton("📚 Просмотреть историю")
        view_history_btn.clicked.connect(self.view_history)
        layout.addWidget(view_history_btn)
        
        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        buttons.accepted.connect(self.save_settings)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)
        
        self.setLayout(layout)
        self.update_stats()
    
    def load_settings(self):
        self.enabled_cb.setChecked(self.history_enricher.enabled)
        self.priority_cb.setChecked(self.history_enricher.priority_history)
        self.use_oui_cb.setChecked(self.history_enricher.use_oui_match)
        self.use_mac5_cb.setChecked(self.history_enricher.use_mac5_match)
    
    def save_settings(self):
        self.history_enricher.set_settings(
            enabled=self.enabled_cb.isChecked(),
            priority_history=self.priority_cb.isChecked(),
            use_oui_match=self.use_oui_cb.isChecked(),
            use_mac5_match=self.use_mac5_cb.isChecked()
        )
        self.accept()
    
    def update_stats(self):
        stats = self.history_enricher.get_stats()
        self.stats_label.setText(
            f"📊 Уникальных OUI: {stats.get('total_oui_vendor', 0)} | "
            f"Уникальных префиксов (5 байт): {stats.get('total_mac5_model', 0)} | "
            f"Производителей: {stats.get('unique_vendors', 0)} | "
            f"📁 Загружено файлов: {stats.get('total_loads', 0)}"
        )
    
    def view_history(self):
        dialog = VendorModelHistoryDialog(self.history_enricher, self)
        dialog.exec_()
        self.update_stats()


# ==================== ДИАЛОГ ИСТОРИИ ПРОИЗВОДИТЕЛЕЙ И МОДЕЛЕЙ ====================

class VendorModelHistoryDialog(QDialog):
    def __init__(self, history_enricher: HistoryEnricher, parent=None):
        super().__init__(parent)
        self.history_enricher = history_enricher
        self.history_db = history_enricher.history_db
        self.setWindowTitle("История производителей и моделей")
        self.setModal(True)
        self.setGeometry(100, 100, 1200, 800)
        self.setStyleSheet(parent.styleSheet() if parent else "")
        self.init_ui()
        self.load_data()
    
    def init_ui(self):
        layout = QVBoxLayout()
        
        title = QLabel("📚 История производителей и моделей из ранее сканированных файлов")
        title.setFont(QFont("Segoe UI", 14, QFont.Bold))
        layout.addWidget(title)
        
        info_label = QLabel(
            "Программа сохраняет информацию о производителях и моделях устройств из всех обработанных файлов.\n"
            "При последующих сканированиях эти данные используются для автоматического обогащения новых файлов.\n"
            "Здесь вы можете просмотреть всю накопленную историю.\n\n"
            "⚠️ Каждый OUI (3 байта) и префикс (5 байт) сохраняются УНИКАЛЬНО, без дублирования.\n"
            "⚠️ Данные из файла имеют приоритет над историческими данными."
        )
        info_label.setWordWrap(True)
        info_label.setStyleSheet("color: #888; padding: 5px;")
        layout.addWidget(info_label)
        
        search_layout = QHBoxLayout()
        search_layout.addWidget(QLabel("Поиск:"))
        self.search_edit = QLineEdit()
        self.search_edit.setPlaceholderText("Название производителя, модели или префикс MAC...")
        self.search_edit.textChanged.connect(self.on_search)
        search_layout.addWidget(self.search_edit, 1)
        
        search_type_layout = QHBoxLayout()
        self.search_vendors_btn = QPushButton("🔍 Поиск производителей")
        self.search_vendors_btn.clicked.connect(lambda: self.on_search_type("vendor"))
        search_type_layout.addWidget(self.search_vendors_btn)
        self.search_models_btn = QPushButton("🔍 Поиск моделей")
        self.search_models_btn.clicked.connect(lambda: self.on_search_type("model"))
        search_type_layout.addWidget(self.search_models_btn)
        clear_search_btn = QPushButton("🗑 Очистить")
        clear_search_btn.clicked.connect(self.clear_search)
        search_type_layout.addWidget(clear_search_btn)
        
        layout.addLayout(search_layout)
        layout.addLayout(search_type_layout)
        
        stats_group = QGroupBox("📊 Статистика истории")
        stats_layout = QHBoxLayout()
        
        self.stats_labels = {}
        stats_fields = [
            ("total_oui_vendor", "Уникальных OUI (3 байта)"),
            ("total_mac5_model", "Уникальных префиксов (5 байт)"),
            ("unique_vendors", "Уникальных производителей"),
            ("total_loads", "Загружено файлов")
        ]
        
        for field, label in stats_fields:
            frame = QFrame()
            frame.setFrameShape(QFrame.StyledPanel)
            frame_layout = QVBoxLayout(frame)
            label_widget = QLabel(label)
            label_widget.setStyleSheet("font-size: 10px; color: #888;")
            frame_layout.addWidget(label_widget)
            value_widget = QLabel("0")
            value_widget.setStyleSheet("font-size: 16px; font-weight: bold;")
            frame_layout.addWidget(value_widget)
            stats_layout.addWidget(frame)
            self.stats_labels[field] = value_widget
        
        stats_group.setLayout(stats_layout)
        layout.addWidget(stats_group)
        
        tabs = QTabWidget()
        
        vendors_tab = QWidget()
        vendors_layout = QVBoxLayout(vendors_tab)
        
        self.vendors_table = QTableWidget()
        self.vendors_table.setColumnCount(4)
        self.vendors_table.setHorizontalHeaderLabels(["OUI (3 байта)", "Производитель", "Кол-во", "Последнее появление"])
        self.vendors_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        vendors_layout.addWidget(self.vendors_table)
        
        tabs.addTab(vendors_tab, "🏭 Производители")
        
        models_tab = QWidget()
        models_layout = QVBoxLayout(models_tab)
        
        self.models_table = QTableWidget()
        self.models_table.setColumnCount(4)
        self.models_table.setHorizontalHeaderLabels(["Префикс (5 байт)", "Модель", "Кол-во", "Последнее появление"])
        self.models_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        models_layout.addWidget(self.models_table)
        
        tabs.addTab(models_tab, "📱 Модели")
        
        top_vendors_tab = QWidget()
        top_vendors_layout = QVBoxLayout(top_vendors_tab)
        
        self.top_vendors_table = QTableWidget()
        self.top_vendors_table.setColumnCount(2)
        self.top_vendors_table.setHorizontalHeaderLabels(["Производитель", "Количество упоминаний"])
        self.top_vendors_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        top_vendors_layout.addWidget(self.top_vendors_table)
        
        tabs.addTab(top_vendors_tab, "🏆 Топ производителей")
        
        top_models_tab = QWidget()
        top_models_layout = QVBoxLayout(top_models_tab)
        
        self.top_models_table = QTableWidget()
        self.top_models_table.setColumnCount(2)
        self.top_models_table.setHorizontalHeaderLabels(["Модель", "Количество упоминаний"])
        self.top_models_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        top_models_layout.addWidget(self.top_models_table)
        
        tabs.addTab(top_models_tab, "🏆 Топ моделей")
        
        loads_tab = QWidget()
        loads_layout = QVBoxLayout(loads_tab)
        
        self.loads_table = QTableWidget()
        self.loads_table.setColumnCount(6)
        self.loads_table.setHorizontalHeaderLabels(["Файл", "Дата загрузки", "Устройств", "Новых производителей", "Новых моделей", "Обогащено из истории"])
        self.loads_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        loads_layout.addWidget(self.loads_table)
        
        tabs.addTab(loads_tab, "📁 История загрузок")
        
        layout.addWidget(tabs)
        
        btn_layout = QHBoxLayout()
        refresh_btn = QPushButton("🔄 Обновить")
        refresh_btn.clicked.connect(self.load_data)
        btn_layout.addWidget(refresh_btn)
        
        clear_history_btn = QPushButton("🗑 Очистить всю историю")
        clear_history_btn.setStyleSheet("background-color: #c0392b;")
        clear_history_btn.clicked.connect(self.clear_history)
        btn_layout.addWidget(clear_history_btn)
        
        btn_layout.addStretch()
        
        close_btn = QPushButton("❌ Закрыть")
        close_btn.clicked.connect(self.accept)
        btn_layout.addWidget(close_btn)
        
        layout.addLayout(btn_layout)
        
        self.setLayout(layout)
    
    def load_data(self):
        stats = self.history_db.get_statistics()
        
        stats_map = {
            'total_oui_vendor': stats.get('total_oui_vendor', 0),
            'total_mac5_model': stats.get('total_mac5_model', 0),
            'unique_vendors': stats.get('unique_vendors', 0),
            'total_loads': stats.get('total_loads', 0)
        }
        
        for field, label_widget in self.stats_labels.items():
            label_widget.setText(str(stats_map.get(field, 0)))
        
        self.load_vendors_table()
        self.load_models_table()
        self.load_top_vendors()
        self.load_top_models()
        self.load_loads_history()
    
    def load_vendors_table(self):
        with self.history_db._get_connection() as conn:
            cursor = conn.execute('''SELECT oui_3byte, vendor, occurrences, last_seen
                FROM oui_vendor_history 
                ORDER BY occurrences DESC, vendor''')
            rows = cursor.fetchall()
        
        self.vendors_table.setRowCount(len(rows))
        for i, row in enumerate(rows):
            self.vendors_table.setItem(i, 0, QTableWidgetItem(row[0] if row[0] else "-"))
            self.vendors_table.setItem(i, 1, QTableWidgetItem(row[1]))
            self.vendors_table.setItem(i, 2, QTableWidgetItem(str(row[2])))
            last_seen = row[3][:10] if row[3] else "-"
            self.vendors_table.setItem(i, 3, QTableWidgetItem(last_seen))
    
    def load_models_table(self):
        with self.history_db._get_connection() as conn:
            cursor = conn.execute('''SELECT mac_5byte, model, occurrences, last_seen
                FROM mac5_model_history 
                WHERE model IS NOT NULL AND model != ''
                ORDER BY occurrences DESC, model''')
            rows = cursor.fetchall()
        
        self.models_table.setRowCount(len(rows))
        for i, row in enumerate(rows):
            self.models_table.setItem(i, 0, QTableWidgetItem(row[0] if row[0] else "-"))
            self.models_table.setItem(i, 1, QTableWidgetItem(row[1]))
            self.models_table.setItem(i, 2, QTableWidgetItem(str(row[2])))
            last_seen = row[3][:10] if row[3] else "-"
            self.models_table.setItem(i, 3, QTableWidgetItem(last_seen))
    
    def load_top_vendors(self):
        rows = self.history_db.get_top_vendors(30)
        self.top_vendors_table.setRowCount(len(rows))
        for i, row in enumerate(rows):
            self.top_vendors_table.setItem(i, 0, QTableWidgetItem(row[0]))
            self.top_vendors_table.setItem(i, 1, QTableWidgetItem(str(row[1])))
    
    def load_top_models(self):
        rows = self.history_db.get_top_models(30)
        self.top_models_table.setRowCount(len(rows))
        for i, row in enumerate(rows):
            self.top_models_table.setItem(i, 0, QTableWidgetItem(row[0]))
            self.top_models_table.setItem(i, 1, QTableWidgetItem(str(row[1])))
    
    def load_loads_history(self):
        rows = self.history_db.get_history_loads(50)
        self.loads_table.setRowCount(len(rows))
        for i, row in enumerate(rows):
            self.loads_table.setItem(i, 0, QTableWidgetItem(Path(row[0]).name if row[0] else "-"))
            self.loads_table.setItem(i, 1, QTableWidgetItem(row[1][:19] if row[1] else "-"))
            self.loads_table.setItem(i, 2, QTableWidgetItem(str(row[2]) if row[2] else "0"))
            self.loads_table.setItem(i, 3, QTableWidgetItem(str(row[3]) if row[3] else "0"))
            self.loads_table.setItem(i, 4, QTableWidgetItem(str(row[4]) if row[4] else "0"))
            enriched = row[5] if len(row) > 5 else 0
            self.loads_table.setItem(i, 5, QTableWidgetItem(str(enriched) if enriched else "0"))
    
    def on_search(self):
        search_term = self.search_edit.text().strip()
        if len(search_term) < 2:
            self.load_vendors_table()
            self.load_models_table()
            return
        
        self.search_vendors(search_term)
        self.search_models(search_term)
    
    def on_search_type(self, search_type):
        search_term = self.search_edit.text().strip()
        if len(search_term) < 2:
            return
        
        if search_type == "vendor":
            self.search_vendors(search_term)
            self.models_table.setRowCount(0)
        else:
            self.search_models(search_term)
            self.vendors_table.setRowCount(0)
    
    def search_vendors(self, search_term):
        rows = self.history_db.search_vendors(search_term)
        self.vendors_table.setRowCount(len(rows))
        for i, row in enumerate(rows):
            self.vendors_table.setItem(i, 0, QTableWidgetItem(row[0] if row[0] else "-"))
            self.vendors_table.setItem(i, 1, QTableWidgetItem(row[1]))
            self.vendors_table.setItem(i, 2, QTableWidgetItem(str(row[2])))
            last_seen = row[3][:10] if row[3] else "-"
            self.vendors_table.setItem(i, 3, QTableWidgetItem(last_seen))
    
    def search_models(self, search_term):
        rows = self.history_db.search_models(search_term)
        self.models_table.setRowCount(len(rows))
        for i, row in enumerate(rows):
            self.models_table.setItem(i, 0, QTableWidgetItem(row[0] if row[0] else "-"))
            self.models_table.setItem(i, 1, QTableWidgetItem(row[1]))
            self.models_table.setItem(i, 2, QTableWidgetItem(str(row[2])))
            last_seen = row[3][:10] if row[3] else "-"
            self.models_table.setItem(i, 3, QTableWidgetItem(last_seen))
    
    def clear_search(self):
        self.search_edit.clear()
        self.load_vendors_table()
        self.load_models_table()
    
    def clear_history(self):
        reply = QMessageBox.question(self, "Очистка истории", 
            "Вы действительно хотите очистить всю историю производителей и моделей?\n"
            "Это действие нельзя отменить!\n\n"
            "Все накопленные данные будут потеряны.",
            QMessageBox.Yes | QMessageBox.No)
        
        if reply == QMessageBox.Yes:
            self.history_db.clear_history()
            QMessageBox.information(self, "Очистка завершена", "История успешно очищена!")
            self.load_data()


# ==================== ДИАЛОГ НАСТРОЙКИ IP-АДРЕС МЭППИНГА ====================

class IPAddressMappingDialog(QDialog):
    def __init__(self, enricher, parent=None):
        super().__init__(parent)
        self.enricher = enricher
        self.parent_window = parent
        self.setWindowTitle("Настройка соответствий IP → Физический адрес")
        self.setModal(True)
        self.setGeometry(200, 200, 900, 700)
        self.setStyleSheet(parent.styleSheet() if parent else "")
        self.init_ui()
        self.load_current_mappings()
        self.load_settings()
    
    def init_ui(self):
        layout = QVBoxLayout()
        
        title = QLabel("🏠 Соответствие IP контроллера → Физический адрес")
        title.setFont(QFont("Segoe UI", 14, QFont.Bold))
        layout.addWidget(title)
        
        info_label = QLabel(
            "Эта функция позволяет автоматически определять физический адрес по IP контроллера.\n"
            "Поддерживается точное и частичное совпадение (по подсети /24).\n\n"
            "⚠️ Адрес из файла имеет приоритет и не будет перезаписан (если не включена опция перезаписи)."
        )
        info_label.setWordWrap(True)
        info_label.setStyleSheet("color: #888; padding: 5px;")
        layout.addWidget(info_label)
        
        settings_group = QGroupBox("⚙️ Настройки обогащения")
        settings_layout = QVBoxLayout()
        
        self.enrich_enabled_cb = QCheckBox("Включить автоматическое обогащение адресов по IP")
        self.enrich_enabled_cb.setChecked(True)
        settings_layout.addWidget(self.enrich_enabled_cb)
        
        self.partial_match_cb = QCheckBox("Использовать частичное совпадение (по подсети /24)")
        self.partial_match_cb.setChecked(True)
        settings_layout.addWidget(self.partial_match_cb)
        
        self.overwrite_cb = QCheckBox("Перезаписывать существующие адреса при обогащении")
        self.overwrite_cb.setChecked(False)
        settings_layout.addWidget(self.overwrite_cb)
        
        save_settings_btn = QPushButton("Сохранить настройки")
        save_settings_btn.clicked.connect(self.save_settings)
        settings_layout.addWidget(save_settings_btn)
        
        settings_group.setLayout(settings_layout)
        layout.addWidget(settings_group)
        
        tabs = QTabWidget()
        
        load_tab = QWidget()
        load_layout = QVBoxLayout(load_tab)
        
        file_group = QGroupBox("Загрузка из файла")
        file_layout = QHBoxLayout()
        self.mapping_file_edit = QLineEdit()
        self.mapping_file_edit.setPlaceholderText("Выберите файл с соответствиями IP и адресов...")
        browse_btn = QPushButton("Обзор")
        browse_btn.clicked.connect(self.browse_mapping_file)
        file_layout.addWidget(self.mapping_file_edit)
        file_layout.addWidget(browse_btn)
        load_btn = QPushButton("Загрузить соответствия")
        load_btn.clicked.connect(self.load_mapping_file)
        file_layout.addWidget(load_btn)
        file_group.setLayout(file_layout)
        load_layout.addWidget(file_group)
        
        auto_group = QGroupBox("Автоматическое определение из данных")
        auto_layout = QVBoxLayout()
        auto_info = QLabel("Автоопределение создаст соответствия из имеющихся данных, где одновременно указаны IP и адрес.")
        auto_info.setWordWrap(True)
        auto_info.setStyleSheet("color: #666;")
        auto_layout.addWidget(auto_info)
        auto_btn = QPushButton("Выполнить автоопределение сейчас")
        auto_btn.clicked.connect(self.auto_detect_from_devices)
        auto_layout.addWidget(auto_btn)
        auto_group.setLayout(auto_layout)
        load_layout.addWidget(auto_group)
        
        load_layout.addStretch()
        tabs.addTab(load_tab, "📥 Загрузка")
        
        manual_tab = QWidget()
        manual_layout = QFormLayout(manual_tab)
        self.manual_ip_edit = QLineEdit()
        self.manual_ip_edit.setPlaceholderText("192.168.1.1")
        manual_layout.addRow("IP адрес контроллера:", self.manual_ip_edit)
        self.manual_address_edit = QLineEdit()
        self.manual_address_edit.setPlaceholderText("ул. Ленина, д. 1")
        manual_layout.addRow("Физический адрес:", self.manual_address_edit)
        add_btn = QPushButton("➕ Добавить соответствие")
        add_btn.clicked.connect(self.add_manual_mapping)
        manual_layout.addRow(add_btn)
        tabs.addTab(manual_tab, "✏️ Ручное добавление")
        
        view_tab = QWidget()
        view_layout = QVBoxLayout(view_tab)
        
        self.mappings_table = QTableWidget()
        self.mappings_table.setColumnCount(4)
        self.mappings_table.setHorizontalHeaderLabels(["IP контроллера", "Физический адрес", "Источник", "Действия"])
        self.mappings_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        view_layout.addWidget(self.mappings_table)
        
        btn_layout = QHBoxLayout()
        clear_all_btn = QPushButton("🗑 Очистить все соответствия")
        clear_all_btn.clicked.connect(self.clear_all_mappings)
        btn_layout.addWidget(clear_all_btn)
        btn_layout.addStretch()
        view_layout.addLayout(btn_layout)
        
        tabs.addTab(view_tab, "📋 Просмотр")
        
        export_tab = QWidget()
        export_layout = QVBoxLayout(export_tab)
        
        export_info = QLabel("Выгрузите все соответствия IP → физический адрес в отдельный файл.")
        export_info.setWordWrap(True)
        export_layout.addWidget(export_info)
        
        export_format_group = QGroupBox("Формат выгрузки")
        export_format_layout = QHBoxLayout()
        self.export_format_combo = QComboBox()
        self.export_format_combo.addItems(["Excel (.xlsx)", "CSV (.csv)", "JSON (.json)", "TXT (.txt)"])
        export_format_layout.addWidget(QLabel("Формат:"))
        export_format_layout.addWidget(self.export_format_combo)
        export_format_group.setLayout(export_format_layout)
        export_layout.addWidget(export_format_group)
        
        export_btn = QPushButton("📎 Выгрузить соответствия в файл")
        export_btn.setMinimumHeight(50)
        export_btn.clicked.connect(self.export_mappings)
        export_layout.addWidget(export_btn)
        
        export_layout.addStretch()
        tabs.addTab(export_tab, "📎 Выгрузка")
        
        layout.addWidget(tabs)
        
        stats_group = QGroupBox("Статистика")
        stats_layout = QHBoxLayout()
        self.stats_label = QLabel("")
        stats_layout.addWidget(self.stats_label)
        stats_group.setLayout(stats_layout)
        layout.addWidget(stats_group)
        
        button_box = QDialogButtonBox(QDialogButtonBox.Close)
        button_box.rejected.connect(self.accept)
        layout.addWidget(button_box)
        
        self.setLayout(layout)
        self.update_stats()
    
    def load_settings(self):
        stats = self.enricher.get_ip_mapping_stats()
        self.enrich_enabled_cb.setChecked(stats.get('enrichment_enabled', True))
        self.partial_match_cb.setChecked(stats.get('partial_match_enabled', True))
    
    def save_settings(self):
        self.enricher.set_ip_enrichment_settings(
            enabled=self.enrich_enabled_cb.isChecked(),
            partial_match=self.partial_match_cb.isChecked(),
            overwrite=self.overwrite_cb.isChecked()
        )
        QMessageBox.information(self, "Успех", "Настройки обогащения сохранены!")
    
    def browse_mapping_file(self):
        f, _ = QFileDialog.getOpenFileName(self, "Выберите файл с соответствиями", "", 
                                           "Excel Files (*.xlsx *.xls *.csv)")
        if f:
            self.mapping_file_edit.setText(f)
    
    def load_mapping_file(self):
        filepath = self.mapping_file_edit.text()
        if not filepath or not os.path.exists(filepath):
            QMessageBox.warning(self, "Ошибка", "Выберите существующий файл!")
            return
        
        col_dialog = QDialog(self)
        col_dialog.setWindowTitle("Выбор колонок")
        col_layout = QFormLayout(col_dialog)
        
        ip_col_combo = QComboBox()
        address_col_combo = QComboBox()
        
        try:
            if filepath.endswith('.csv'):
                df = pd.read_csv(filepath, encoding='utf-8', nrows=5, dtype=str)
            else:
                df = pd.read_excel(filepath, nrows=5, dtype=str, engine='openpyxl')
            
            columns = df.columns.tolist() if hasattr(df, 'columns') else [f"Колонка {i}" for i in range(len(df.columns))]
            for col in columns:
                ip_col_combo.addItem(str(col))
                address_col_combo.addItem(str(col))
            
            ip_col_combo.setCurrentText(columns[0] if columns else "")
            if len(columns) > 1:
                address_col_combo.setCurrentText(columns[1])
            
        except Exception as e:
            QMessageBox.warning(self, "Ошибка", f"Не удалось прочитать файл: {e}")
            return
        
        col_layout.addRow("Колонка с IP:", ip_col_combo)
        col_layout.addRow("Колонка с адресом:", address_col_combo)
        
        btn_box = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        btn_box.accepted.connect(col_dialog.accept)
        btn_box.rejected.connect(col_dialog.reject)
        col_layout.addRow(btn_box)
        
        if col_dialog.exec_():
            count = self.enricher.load_ip_address_mapping(filepath, 
                                                          ip_col_combo.currentText(), 
                                                          address_col_combo.currentText())
            if count > 0:
                self.load_current_mappings()
                QMessageBox.information(self, "Успех", f"Загружено {count} соответствий IP → адрес!")
            else:
                QMessageBox.warning(self, "Ошибка", "Не найдено валидных соответствий в файле!")
    
    def auto_detect_from_devices(self):
        count = self.enricher.auto_detect_ip_address_mapping()
        if count > 0:
            self.load_current_mappings()
            QMessageBox.information(self, "Успех", f"Автоопределено {count} соответствий IP → адрес!")
        else:
            QMessageBox.information(self, "Информация", "Не найдено соответствий в загруженных данных.")
    
    def add_manual_mapping(self):
        ip = self.manual_ip_edit.text().strip()
        address = self.manual_address_edit.text().strip()
        
        if not ip or not address:
            QMessageBox.warning(self, "Ошибка", "Заполните оба поля!")
            return
        
        if not validate_ip(ip):
            QMessageBox.warning(self, "Ошибка", f"'{ip}' не является корректным IP-адресом!")
            return
        
        if self.enricher.ip_address_mapper.add_mapping(ip, address, source="Ручное добавление"):
            self.manual_ip_edit.clear()
            self.manual_address_edit.clear()
            self.load_current_mappings()
            QMessageBox.information(self, "Успех", f"Добавлено соответствие: {ip} → {address}")
        else:
            QMessageBox.warning(self, "Ошибка", "Не удалось добавить соответствие!")
    
    def export_mappings(self):
        if len(self.enricher.ip_address_mapper.ip_to_address_map) == 0:
            QMessageBox.warning(self, "Ошибка", "Нет соответствий для выгрузки!")
            return
        
        format_map = {"Excel (.xlsx)": "excel", "CSV (.csv)": "csv", "JSON (.json)": "json", "TXT (.txt)": "txt"}
        format_type = format_map.get(self.export_format_combo.currentText(), "excel")
        ext = self.export_format_combo.currentText().split()[0].lower().replace('(', '').replace(')', '')
        
        filename, _ = QFileDialog.getSaveFileName(self, "Сохранить соответствия",
                                                   f"ip_address_mappings_{datetime.now().strftime('%Y%m%d_%H%M%S')}.{ext}",
                                                   f"{self.export_format_combo.currentText()} Files (*.{ext})")
        if filename:
            if self.enricher.export_ip_mappings(filename, format_type):
                QMessageBox.information(self, "Успех", f"Соответствия сохранены в {filename}")
            else:
                QMessageBox.warning(self, "Ошибка", "Не удалось сохранить соответствия!")
    
    def load_current_mappings(self):
        self.mappings_table.setRowCount(0)
        for ip, address in self.enricher.ip_address_mapper.ip_to_address_map.items():
            row = self.mappings_table.rowCount()
            self.mappings_table.insertRow(row)
            self.mappings_table.setItem(row, 0, QTableWidgetItem(ip))
            self.mappings_table.setItem(row, 1, QTableWidgetItem(address))
            
            source = "Файл" if self.enricher.ip_address_mapper.mapping_file else "Автоопределение"
            self.mappings_table.setItem(row, 2, QTableWidgetItem(source))
            
            delete_btn = QPushButton("🗑 Удалить")
            delete_btn.clicked.connect(lambda checked, i=ip, a=address: self.delete_mapping(i, a))
            self.mappings_table.setCellWidget(row, 3, delete_btn)
        
        self.update_stats()
    
    def delete_mapping(self, ip, address):
        if ip in self.enricher.ip_address_mapper.ip_to_address_map:
            del self.enricher.ip_address_mapper.ip_to_address_map[ip]
        if address in self.enricher.ip_address_mapper.address_to_ip_map:
            del self.enricher.ip_address_mapper.address_to_ip_map[address]
        self.load_current_mappings()
    
    def clear_all_mappings(self):
        if QMessageBox.question(self, "Подтверждение", "Удалить все соответствия?",
                                QMessageBox.Yes | QMessageBox.No) == QMessageBox.Yes:
            self.enricher.ip_address_mapper.clear()
            self.load_current_mappings()
            QMessageBox.information(self, "Успех", "Все соответствия удалены!")
    
    def update_stats(self):
        stats = self.enricher.get_ip_mapping_stats()
        self.stats_label.setText(f"Всего соответствий: {stats['total_mappings']} | "
                                f"Уникальных IP: {stats['unique_ips']} | "
                                f"Загружено из файла: {'Да' if stats['has_file'] else 'Нет'} | "
                                f"Автоопределено: {'Да' if stats['auto_detected'] else 'Нет'} | "
                                f"Обогащение: {'Вкл' if stats.get('enrichment_enabled', True) else 'Выкл'} | "
                                f"Частичное совпадение: {'Вкл' if stats.get('partial_match_enabled', True) else 'Выкл'}")


# ==================== ДИАЛОГ НАСТРОЙКИ КОЛОНОК ДЛЯ ФАЙЛОВ ====================

class ColumnMappingDialog(QDialog):
    def __init__(self, enricher, parent=None):
        super().__init__(parent)
        self.enricher = enricher
        self.setWindowTitle("Настройка колонок для файлов")
        self.setModal(True)
        self.setGeometry(200, 200, 900, 800)
        self.setStyleSheet(parent.styleSheet() if parent else "")
        self.init_ui()
    
    def init_ui(self):
        layout = QVBoxLayout()
        title = QLabel("📁 Настройка колонок для файлов")
        title.setFont(QFont("Segoe UI", 14, QFont.Bold))
        layout.addWidget(title)
        
        info_label = QLabel("Укажите, в каких колонках находятся данные. MAC-адрес обязателен.\n"
                           "Данные из файла имеют наивысший приоритет и не будут перезаписаны обогащением.")
        info_label.setWordWrap(True)
        layout.addWidget(info_label)
        
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll_widget = QWidget()
        scroll_layout = QVBoxLayout(scroll_widget)
        
        col_options = ['Не указано'] + get_all_column_letters(50)
        
        self.mapping_widgets = {}
        self.custom_field_widgets = {}
        
        for alias, info in self.enricher.files.items():
            group = QGroupBox(f"📄 Файл: {alias}")
            group_layout = QVBoxLayout()
            
            form_layout = QFormLayout()
            
            mac_combo = QComboBox()
            mac_combo.addItems(col_options)
            current_mac = info.get('mapping', {}).get('mac_col', 'A')
            if current_mac in col_options:
                mac_combo.setCurrentText(current_mac)
            form_layout.addRow("📡 MAC-адрес:*", mac_combo)
            
            vendor_combo = QComboBox()
            vendor_combo.addItems(col_options)
            current_vendor = info.get('mapping', {}).get('vendor_col')
            if current_vendor and current_vendor in col_options:
                vendor_combo.setCurrentText(current_vendor)
            form_layout.addRow("🏭 Производитель:", vendor_combo)
            
            model_combo = QComboBox()
            model_combo.addItems(col_options)
            current_model = info.get('mapping', {}).get('model_col')
            if current_model and current_model in col_options:
                model_combo.setCurrentText(current_model)
            form_layout.addRow("📱 Модель:", model_combo)
            
            address_combo = QComboBox()
            address_combo.addItems(col_options)
            current_address = info.get('mapping', {}).get('address_col')
            if current_address and current_address in col_options:
                address_combo.setCurrentText(current_address)
            form_layout.addRow("📍 Адрес:", address_combo)
            
            ip_combo = QComboBox()
            ip_combo.addItems(col_options)
            current_ip = info.get('mapping', {}).get('ip_col')
            if current_ip and current_ip in col_options:
                ip_combo.setCurrentText(current_ip)
            form_layout.addRow("🌐 IP-адрес:", ip_combo)
            
            room_combo = QComboBox()
            room_combo.addItems(col_options)
            current_room = info.get('mapping', {}).get('room_col')
            if current_room and current_room in col_options:
                room_combo.setCurrentText(current_room)
            form_layout.addRow("🚪 Помещение:", room_combo)
            
            switch_ip_combo = QComboBox()
            switch_ip_combo.addItems(col_options)
            current_switch_ip = info.get('mapping', {}).get('switch_ip_col')
            if current_switch_ip and current_switch_ip in col_options:
                switch_ip_combo.setCurrentText(current_switch_ip)
            form_layout.addRow("🔌 IP коммутатора:", switch_ip_combo)
            
            switch_port_combo = QComboBox()
            switch_port_combo.addItems(col_options)
            current_switch_port = info.get('mapping', {}).get('switch_port_col')
            if current_switch_port and current_switch_port in col_options:
                switch_port_combo.setCurrentText(current_switch_port)
            form_layout.addRow("🔌 Порт подключения:", switch_port_combo)
            
            group_layout.addLayout(form_layout)
            
            custom_group = QGroupBox("➕ Пользовательские поля")
            custom_layout = QVBoxLayout()
            custom_fields_widget = QWidget()
            custom_fields_layout = QVBoxLayout(custom_fields_widget)
            custom_fields_layout.setContentsMargins(0, 0, 0, 0)
            
            existing_custom = info.get('mapping', {}).get('custom_fields', [])
            self.custom_field_widgets[alias] = []
            
            for field_name, display_name in existing_custom:
                self.add_custom_field_row(alias, display_name, col_options, custom_fields_layout)
            
            custom_layout.addWidget(custom_fields_widget)
            
            add_custom_btn = QPushButton("➕ Добавить пользовательское поле")
            add_custom_btn.clicked.connect(lambda checked, a=alias, c=custom_fields_layout: self.add_custom_field(a, c, col_options))
            custom_layout.addWidget(add_custom_btn)
            
            custom_group.setLayout(custom_layout)
            group_layout.addWidget(custom_group)
            
            btn_layout = QHBoxLayout()
            auto_btn = QPushButton("🤖 AI-автоопределение колонок")
            auto_btn.setStyleSheet("font-weight: bold;")
            auto_btn.clicked.connect(lambda checked, a=alias: self.ai_auto_detect_for_file(a))
            btn_layout.addWidget(auto_btn)
            
            manual_btn = QPushButton("📝 Ручное автоопределение")
            manual_btn.clicked.connect(lambda checked, a=alias: self.manual_detect_for_file(a))
            btn_layout.addWidget(manual_btn)
            
            group_layout.addLayout(btn_layout)
            
            group.setLayout(group_layout)
            scroll_layout.addWidget(group)
            
            self.mapping_widgets[alias] = {
                'mac': mac_combo, 'vendor': vendor_combo, 'model': model_combo,
                'address': address_combo, 'ip': ip_combo, 'room': room_combo,
                'switch_ip': switch_ip_combo, 'switch_port': switch_port_combo
            }
        
        scroll_layout.addStretch()
        scroll.setWidget(scroll_widget)
        layout.addWidget(scroll)
        
        btn_layout = QHBoxLayout()
        auto_all_btn = QPushButton("🤖 AI-автоопределение для всех файлов")
        auto_all_btn.setStyleSheet("font-weight: bold;")
        auto_all_btn.clicked.connect(self.ai_auto_detect_all)
        btn_layout.addWidget(auto_all_btn)
        btn_layout.addStretch()
        apply_btn = QPushButton("✅ Применить настройки")
        apply_btn.clicked.connect(self.save_mappings)
        btn_layout.addWidget(apply_btn)
        cancel_btn = QPushButton("❌ Отмена")
        cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(cancel_btn)
        
        layout.addLayout(btn_layout)
        
        self.setLayout(layout)
    
    def add_custom_field_row(self, alias, display_name, col_options, layout):
        field_widget = QWidget()
        field_layout = QHBoxLayout(field_widget)
        field_layout.setContentsMargins(0, 0, 0, 0)
        
        label = QLabel(f"{display_name}:")
        label.setMinimumWidth(120)
        field_layout.addWidget(label)
        
        combo = QComboBox()
        combo.addItems(col_options)
        combo.setCurrentText('Не указано')
        field_layout.addWidget(combo)
        
        remove_btn = QToolButton()
        remove_btn.setText("❌")
        remove_btn.clicked.connect(lambda: self.remove_custom_field(alias, field_widget, display_name))
        field_layout.addWidget(remove_btn)
        
        layout.addWidget(field_widget)
        
        self.custom_field_widgets[alias].append({'widget': field_widget, 'combo': combo, 'name': display_name})
    
    def remove_custom_field(self, alias, widget, field_name):
        widget.deleteLater()
        self.custom_field_widgets[alias] = [w for w in self.custom_field_widgets[alias] if w['name'] != field_name]
    
    def add_custom_field(self, alias, layout, col_options):
        name, ok = QInputDialog.getText(self, "Пользовательское поле", "Введите название поля:")
        if ok and name.strip():
            self.add_custom_field_row(alias, name.strip(), col_options, layout)
    
    def ai_auto_detect_for_file(self, alias):
        info = self.enricher.files.get(alias)
        if not info:
            QMessageBox.warning(self, "Ошибка", f"Файл {alias} не найден!")
            return
        
        filepath = info['path']
        if not os.path.exists(filepath):
            QMessageBox.warning(self, "Ошибка", f"Файл {filepath} не существует!")
            return
        
        try:
            if filepath.endswith('.csv'):
                df = pd.read_csv(filepath, encoding='utf-8', nrows=100, dtype=str)
            else:
                df = pd.read_excel(filepath, header=None, dtype=str, nrows=100, engine='openpyxl')
            
            if df.empty or len(df.columns) == 0:
                QMessageBox.warning(self, "Ошибка", f"Файл {alias} пуст или не содержит данных!")
                return
            
            has_headers = False
            headers = []
            data_df = df.copy()
            
            if len(df) > 0:
                first_row = df.iloc[0]
                header_candidates = [str(v).strip() if not pd.isna(v) else '' for v in first_row]
                non_empty_headers = [h for h in header_candidates if h and h != 'nan']
                if non_empty_headers:
                    is_header = True
                    for val in non_empty_headers[:5]:
                        if validate_mac(val):
                            is_header = False
                            break
                    if is_header:
                        has_headers = True
                        headers = [str(h).strip() if not pd.isna(h) else get_column_letter(i) for i, h in enumerate(first_row)]
                        data_df = df.iloc[1:].reset_index(drop=True)
            
            mapping, candidates = AIColumnDetector.detect_columns_with_ai(data_df, headers, has_headers)
            
            show_conflict_dialog = False
            for col_idx, cand in candidates.items():
                scores = cand['scores']
                top_scores = sorted(scores.values(), reverse=True)
                if len(top_scores) > 1 and top_scores[0] > 0.25 and top_scores[1] > 0.15:
                    show_conflict_dialog = True
                    break
            
            if show_conflict_dialog and candidates:
                dialog = ColumnConflictDialog(candidates, headers, has_headers, data_df, self)
                if dialog.exec_():
                    user_mapping = dialog.get_mapping()
                    for field_key, col_letter in user_mapping.items():
                        if field_key == 'mac':
                            mapping['mac_col'] = col_letter
                        elif field_key == 'vendor':
                            mapping['vendor_col'] = col_letter
                        elif field_key == 'model':
                            mapping['model_col'] = col_letter
                        elif field_key == 'address':
                            mapping['address_col'] = col_letter
                        elif field_key == 'ip':
                            mapping['ip_col'] = col_letter
                        elif field_key == 'room':
                            mapping['room_col'] = col_letter
                        elif field_key == 'switch_ip':
                            mapping['switch_ip_col'] = col_letter
                        elif field_key == 'switch_port':
                            mapping['switch_port_col'] = col_letter
            
            if mapping.get('mac_col'):
                self.mapping_widgets[alias]['mac'].setCurrentText(mapping['mac_col'])
            if mapping.get('vendor_col'):
                self.mapping_widgets[alias]['vendor'].setCurrentText(mapping['vendor_col'])
            if mapping.get('model_col'):
                self.mapping_widgets[alias]['model'].setCurrentText(mapping['model_col'])
            if mapping.get('address_col'):
                self.mapping_widgets[alias]['address'].setCurrentText(mapping['address_col'])
            if mapping.get('ip_col'):
                self.mapping_widgets[alias]['ip'].setCurrentText(mapping['ip_col'])
            if mapping.get('room_col'):
                self.mapping_widgets[alias]['room'].setCurrentText(mapping['room_col'])
            if mapping.get('switch_ip_col'):
                self.mapping_widgets[alias]['switch_ip'].setCurrentText(mapping['switch_ip_col'])
            if mapping.get('switch_port_col'):
                self.mapping_widgets[alias]['switch_port'].setCurrentText(mapping['switch_port_col'])
            
            QMessageBox.information(self, "Готово", f"AI-автоопределение для файла {alias} выполнено!")
            
        except Exception as e:
            QMessageBox.warning(self, "Ошибка", f"Ошибка AI-автоопределения: {str(e)}")
    
    def manual_detect_for_file(self, alias):
        info = self.enricher.files.get(alias)
        if not info:
            QMessageBox.warning(self, "Ошибка", f"Файл {alias} не найден!")
            return
        
        filepath = info['path']
        try:
            if filepath.endswith('.csv'):
                df = pd.read_csv(filepath, encoding='utf-8', nrows=50, dtype=str)
            else:
                df = pd.read_excel(filepath, header=None, dtype=str, nrows=50, engine='openpyxl')
            
            if df.empty or len(df.columns) == 0:
                QMessageBox.warning(self, "Ошибка", f"Файл {alias} пуст или не содержит данных!")
                return
            
            has_headers = False
            headers = []
            if len(df) > 0:
                first_row = df.iloc[0]
                header_candidates = [str(v).strip() if not pd.isna(v) else '' for v in first_row]
                if header_candidates:
                    is_header = True
                    for val in header_candidates[:5]:
                        if val and validate_mac(val):
                            is_header = False
                            break
                    if is_header:
                        has_headers = True
                        headers = [str(h).strip() if not pd.isna(h) else get_column_letter(i) for i, h in enumerate(first_row)]
                        df = df.iloc[1:]
            
            mapping = AutoColumnDetector.auto_detect_mapping(df, headers, has_headers)
            
            if mapping.get('mac_col'):
                self.mapping_widgets[alias]['mac'].setCurrentText(mapping['mac_col'])
            if mapping.get('vendor_col'):
                self.mapping_widgets[alias]['vendor'].setCurrentText(mapping['vendor_col'])
            if mapping.get('address_col'):
                self.mapping_widgets[alias]['address'].setCurrentText(mapping['address_col'])
            if mapping.get('ip_col'):
                self.mapping_widgets[alias]['ip'].setCurrentText(mapping['ip_col'])
            if mapping.get('room_col'):
                self.mapping_widgets[alias]['room'].setCurrentText(mapping['room_col'])
            if mapping.get('switch_ip_col'):
                self.mapping_widgets[alias]['switch_ip'].setCurrentText(mapping['switch_ip_col'])
            if mapping.get('switch_port_col'):
                self.mapping_widgets[alias]['switch_port'].setCurrentText(mapping['switch_port_col'])
            
            QMessageBox.information(self, "Готово", f"Ручное автоопределение для файла {alias} выполнено!")
        except Exception as e:
            QMessageBox.warning(self, "Ошибка", f"Ошибка автоопределения: {str(e)}")
    
    def ai_auto_detect_all(self):
        for alias in self.mapping_widgets:
            self.ai_auto_detect_for_file(alias)
        QMessageBox.information(self, "Готово", "AI-автоопределение для всех файлов выполнено!")
    
    def save_mappings(self):
        for alias, widgets in self.mapping_widgets.items():
            mapping = {
                'mac_col': widgets['mac'].currentText(),
                'vendor_col': widgets['vendor'].currentText() if widgets['vendor'].currentText() != 'Не указано' else None,
                'model_col': widgets['model'].currentText() if widgets['model'].currentText() != 'Не указано' else None,
                'address_col': widgets['address'].currentText() if widgets['address'].currentText() != 'Не указано' else None,
                'ip_col': widgets['ip'].currentText() if widgets['ip'].currentText() != 'Не указано' else None,
                'room_col': widgets['room'].currentText() if widgets['room'].currentText() != 'Не указано' else None,
                'switch_ip_col': widgets['switch_ip'].currentText() if widgets['switch_ip'].currentText() != 'Не указано' else None,
                'switch_port_col': widgets['switch_port'].currentText() if widgets['switch_port'].currentText() != 'Не указано' else None,
                'has_headers': False,
                'custom_fields': []
            }
            
            if alias in self.custom_field_widgets:
                for field in self.custom_field_widgets[alias]:
                    field_name = f"custom_{field['name'].replace(' ', '_')}"
                    mapping['custom_fields'].append((field_name, field['name']))
                    mapping[field_name] = field['combo'].currentText() if field['combo'].currentText() != 'Не указано' else None
            
            self.enricher.set_mapping(alias, mapping)
        self.accept()


# ==================== ДИАЛОГ УПРАВЛЕНИЯ КОЛОНКАМИ РЕЗУЛЬТАТОВ ====================

class ColumnManagerDialog(QDialog):
    def __init__(self, column_manager, parent=None):
        super().__init__(parent)
        self.column_manager = column_manager
        self.setWindowTitle("Управление колонками результатов")
        self.setModal(True)
        self.setMinimumSize(750, 650)
        self.setStyleSheet(parent.styleSheet() if parent else "")
        self.init_ui()
        self.update_lists()
    
    def init_ui(self):
        layout = QVBoxLayout()
        title = QLabel("Управление отображаемыми колонками")
        title.setFont(QFont("Segoe UI", 14, QFont.Bold))
        layout.addWidget(title)
        
        info_label = QLabel("Выберите колонки для отображения. Порядок можно изменить кнопками вверх/вниз.")
        info_label.setWordWrap(True)
        layout.addWidget(info_label)
        
        main_widget = QWidget()
        main_layout = QHBoxLayout(main_widget)
        
        left_panel = QWidget()
        left_layout = QVBoxLayout(left_panel)
        left_layout.addWidget(QLabel("Доступные колонки:"))
        self.available_list = QListWidget()
        self.available_list.setSelectionMode(QListWidget.ExtendedSelection)
        self.available_list.setMinimumWidth(250)
        left_layout.addWidget(self.available_list)
        main_layout.addWidget(left_panel)
        
        center_panel = QWidget()
        center_layout = QVBoxLayout(center_panel)
        center_layout.addStretch()
        self.add_btn = QPushButton("→ Добавить →")
        self.add_btn.setMinimumWidth(100)
        self.add_btn.clicked.connect(self.add_columns)
        center_layout.addWidget(self.add_btn)
        self.add_all_btn = QPushButton("→→ Добавить все →→")
        self.add_all_btn.setMinimumWidth(100)
        self.add_all_btn.clicked.connect(self.add_all_columns)
        center_layout.addWidget(self.add_all_btn)
        center_layout.addSpacing(15)
        self.remove_btn = QPushButton("← Удалить ←")
        self.remove_btn.setMinimumWidth(100)
        self.remove_btn.clicked.connect(self.remove_columns)
        center_layout.addWidget(self.remove_btn)
        self.remove_all_btn = QPushButton("←← Удалить все ←←")
        self.remove_all_btn.setMinimumWidth(100)
        self.remove_all_btn.clicked.connect(self.remove_all_columns)
        center_layout.addWidget(self.remove_all_btn)
        center_layout.addSpacing(20)
        self.up_btn = QPushButton("↑ Вверх ↑")
        self.up_btn.setMinimumWidth(100)
        self.up_btn.clicked.connect(self.move_up)
        center_layout.addWidget(self.up_btn)
        self.down_btn = QPushButton("↓ Вниз ↓")
        self.down_btn.setMinimumWidth(100)
        self.down_btn.clicked.connect(self.move_down)
        center_layout.addWidget(self.down_btn)
        center_layout.addStretch()
        main_layout.addWidget(center_panel)
        
        right_panel = QWidget()
        right_layout = QVBoxLayout(right_panel)
        right_layout.addWidget(QLabel("Выбранные колонки (порядок экспорта):"))
        self.selected_list = QListWidget()
        self.selected_list.setSelectionMode(QListWidget.ExtendedSelection)
        self.selected_list.setMinimumWidth(250)
        right_layout.addWidget(self.selected_list)
        main_layout.addWidget(right_panel)
        
        layout.addWidget(main_widget)
        
        action_layout = QHBoxLayout()
        add_custom_btn = QPushButton("Добавить пользовательскую колонку")
        add_custom_btn.clicked.connect(self.add_custom_column)
        action_layout.addWidget(add_custom_btn)
        remove_custom_btn = QPushButton("Удалить пользовательскую колонку")
        remove_custom_btn.clicked.connect(self.remove_custom_column)
        action_layout.addWidget(remove_custom_btn)
        reset_btn = QPushButton("Сбросить к стандартным")
        reset_btn.clicked.connect(self.reset_to_default)
        action_layout.addWidget(reset_btn)
        action_layout.addStretch()
        layout.addLayout(action_layout)
        
        self.info_label = QLabel("")
        layout.addWidget(self.info_label)
        
        button_box = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        button_box.accepted.connect(self.on_accept)
        button_box.rejected.connect(self.reject)
        layout.addWidget(button_box)
        
        self.setLayout(layout)
    
    def update_lists(self):
        self.available_list.clear()
        self.selected_list.clear()
        visible_set = set(self.column_manager.get_visible_columns())
        for col in self.column_manager.ALL_COLUMNS:
            if col not in visible_set:
                self.available_list.addItem(col)
        for col in self.column_manager.get_visible_columns():
            self.selected_list.addItem(col)
        self.info_label.setText(f"Выбрано {self.selected_list.count()} колонок из {len(self.column_manager.ALL_COLUMNS)}")
    
    def add_columns(self):
        for item in self.available_list.selectedItems():
            self.column_manager.add_column(item.text())
        self.update_lists()
    
    def add_all_columns(self):
        for i in range(self.available_list.count()):
            self.column_manager.add_column(self.available_list.item(i).text())
        self.update_lists()
    
    def remove_columns(self):
        for item in self.selected_list.selectedItems():
            if item.text() != "№":
                self.column_manager.remove_column(item.text())
        self.update_lists()
    
    def remove_all_columns(self):
        for col in self.column_manager.get_visible_columns():
            if col != "№":
                self.column_manager.remove_column(col)
        self.update_lists()
    
    def move_up(self):
        current_row = self.selected_list.currentRow()
        if current_row > 0:
            col = self.selected_list.currentItem().text()
            self.column_manager.move_up(col)
            self.update_lists()
            self.selected_list.setCurrentRow(current_row - 1)
    
    def move_down(self):
        current_row = self.selected_list.currentRow()
        if current_row >= 0 and current_row < self.selected_list.count() - 1:
            col = self.selected_list.currentItem().text()
            self.column_manager.move_down(col)
            self.update_lists()
            self.selected_list.setCurrentRow(current_row + 1)
    
    def add_custom_column(self):
        name, ok = QInputDialog.getText(self, "Пользовательская колонка", "Введите название новой колонки:")
        if ok and name.strip():
            if self.column_manager.add_custom_column(name.strip()):
                self.update_lists()
                QMessageBox.information(self, "Успех", f"Колонка '{name.strip()}' добавлена!")
            else:
                QMessageBox.warning(self, "Ошибка", "Колонка с таким именем уже существует!")
    
    def remove_custom_column(self):
        custom_cols = self.column_manager.get_custom_columns()
        if not custom_cols:
            QMessageBox.warning(self, "Ошибка", "Нет пользовательских колонок для удаления!")
            return
        col_name, ok = QInputDialog.getItem(self, "Удаление колонки", "Выберите колонку для удаления:", custom_cols, 0, False)
        if ok and col_name:
            self.column_manager.remove_custom_column(col_name)
            self.update_lists()
            QMessageBox.information(self, "Успех", f"Колонка '{col_name}' удалена!")
    
    def reset_to_default(self):
        self.column_manager.reset_to_default()
        self.update_lists()
    
    def on_accept(self):
        self.column_manager.set_visible_columns([self.selected_list.item(i).text() for i in range(self.selected_list.count())])
        self.accept()


# ==================== ДИАЛОГ ВЫБОРА ФОРМАТОВ OUI ====================

class OUIFormatSelectionDialog(QDialog):
    def __init__(self, current_formats=None, parent=None):
        super().__init__(parent)
        self.current_formats = current_formats or {3: True, 4: False, 5: False, 6: False}
        self.setWindowTitle("Выбор форматов OUI")
        self.setModal(True)
        self.setFixedSize(500, 500)
        self.setStyleSheet(parent.styleSheet() if parent else "")
        self.init_ui()
    
    def init_ui(self):
        layout = QVBoxLayout()
        title = QLabel("Выберите форматы OUI")
        title.setFont(QFont("Segoe UI", 14, QFont.Bold))
        layout.addWidget(title)
        info_label = QLabel("Выберите форматы OUI для сравнения и обогащения данных")
        info_label.setWordWrap(True)
        layout.addWidget(info_label)
        
        formats_group = QGroupBox("Форматы OUI")
        formats_layout = QVBoxLayout()
        self.oui3_check = QCheckBox("3 байта (XX:XX:XX) - стандартный OUI производителя")
        self.oui3_check.setChecked(self.current_formats.get(3, True))
        self.oui4_check = QCheckBox("4 байта (XX:XX:XX:XX) - расширенный OUI")
        self.oui4_check.setChecked(self.current_formats.get(4, False))
        self.oui5_check = QCheckBox("5 байт (XX:XX:XX:XX:XX) - полный префикс")
        self.oui5_check.setChecked(self.current_formats.get(5, False))
        self.oui6_check = QCheckBox("6 байт (XX:XX:XX:XX:XX:XX) - полный MAC-адрес")
        self.oui6_check.setChecked(self.current_formats.get(6, False))
        formats_layout.addWidget(self.oui3_check)
        formats_layout.addWidget(self.oui4_check)
        formats_layout.addWidget(self.oui5_check)
        formats_layout.addWidget(self.oui6_check)
        formats_group.setLayout(formats_layout)
        layout.addWidget(formats_group)
        
        examples_group = QGroupBox("Примеры для MAC 00:1A:11:22:33:44:55:66")
        examples_layout = QVBoxLayout()
        self.example3_label = QLabel()
        self.example4_label = QLabel()
        self.example5_label = QLabel()
        self.example6_label = QLabel()
        self.update_examples()
        examples_layout.addWidget(self.example3_label)
        examples_layout.addWidget(self.example4_label)
        examples_layout.addWidget(self.example5_label)
        examples_layout.addWidget(self.example6_label)
        examples_group.setLayout(examples_layout)
        layout.addWidget(examples_group)
        
        select_all_btn = QPushButton("Выбрать все")
        select_all_btn.clicked.connect(lambda: self.set_all_checked(True))
        deselect_all_btn = QPushButton("Снять все")
        deselect_all_btn.clicked.connect(lambda: self.set_all_checked(False))
        btn_layout = QHBoxLayout()
        btn_layout.addWidget(select_all_btn)
        btn_layout.addWidget(deselect_all_btn)
        layout.addLayout(btn_layout)
        
        button_box = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        button_box.accepted.connect(self.accept)
        button_box.rejected.connect(self.reject)
        layout.addWidget(button_box)
        self.setLayout(layout)
    
    def set_all_checked(self, checked):
        self.oui3_check.setChecked(checked)
        self.oui4_check.setChecked(checked)
        self.oui5_check.setChecked(checked)
        self.oui6_check.setChecked(checked)
        self.update_examples()
    
    def update_examples(self):
        mac = "00:1A:11:22:33:44:55:66"
        oui3 = extract_oui(mac, 3)
        formatted3 = format_oui(oui3, 3)
        vendor3 = VendorDatabase.get_vendor_by_oui(oui3)
        self.example3_label.setText(f"3 байта: {formatted3} → {vendor3}")
        oui4 = extract_oui(mac, 4)
        formatted4 = format_oui(oui4, 4)
        self.example4_label.setText(f"4 байта: {formatted4}")
        oui5 = extract_oui(mac, 5)
        formatted5 = format_oui(oui5, 5)
        model5 = VendorDatabase.get_model_by_prefix(oui5)
        self.example5_label.setText(f"5 байт: {formatted5} → {model5 if model5 else 'модель не найдена'}")
        oui6 = extract_oui(mac, 6)
        formatted6 = format_oui(oui6, 6)
        self.example6_label.setText(f"6 байт (полный MAC): {formatted6}")
    
    def get_selected_formats(self):
        return {3: self.oui3_check.isChecked(), 4: self.oui4_check.isChecked(),
                5: self.oui5_check.isChecked(), 6: self.oui6_check.isChecked()}


# ==================== ДИАЛОГ НАСТРОЙКИ КОЛОНОК ДЛЯ ФАЙЛОВ ПРИ СРАВНЕНИИ ====================

class ComparisonFileMappingDialog(QDialog):
    def __init__(self, filepath, alias, parent=None):
        super().__init__(parent)
        self.filepath = filepath
        self.alias = alias
        self.mapping = {}
        self.setWindowTitle(f"Настройка колонок для файла: {alias}")
        self.setModal(True)
        self.setGeometry(300, 300, 500, 450)
        self.setStyleSheet(parent.styleSheet() if parent else "")
        self.init_ui()
    
    def init_ui(self):
        layout = QVBoxLayout()
        
        title = QLabel(f"Настройка колонок для файла: {self.alias}")
        title.setFont(QFont("Segoe UI", 14, QFont.Bold))
        layout.addWidget(title)
        
        info_label = QLabel("Укажите, в каких колонках находятся данные. MAC-адрес обязателен для сравнения.")
        info_label.setWordWrap(True)
        layout.addWidget(info_label)
        
        col_options = ['Не указано'] + get_all_column_letters(50)
        
        form_layout = QFormLayout()
        
        self.mac_combo = QComboBox()
        self.mac_combo.addItems(col_options)
        self.mac_combo.setCurrentText('A')
        form_layout.addRow("MAC-адрес:*", self.mac_combo)
        
        self.vendor_combo = QComboBox()
        self.vendor_combo.addItems(col_options)
        form_layout.addRow("Производитель:", self.vendor_combo)
        
        self.model_combo = QComboBox()
        self.model_combo.addItems(col_options)
        form_layout.addRow("Модель:", self.model_combo)
        
        self.address_combo = QComboBox()
        self.address_combo.addItems(col_options)
        form_layout.addRow("Адрес:", self.address_combo)
        
        self.ip_combo = QComboBox()
        self.ip_combo.addItems(col_options)
        form_layout.addRow("IP-адрес:", self.ip_combo)
        
        self.room_combo = QComboBox()
        self.room_combo.addItems(col_options)
        form_layout.addRow("Помещение:", self.room_combo)
        
        self.switch_ip_combo = QComboBox()
        self.switch_ip_combo.addItems(col_options)
        form_layout.addRow("IP коммутатора:", self.switch_ip_combo)
        
        self.switch_port_combo = QComboBox()
        self.switch_port_combo.addItems(col_options)
        form_layout.addRow("Порт подключения:", self.switch_port_combo)
        
        layout.addLayout(form_layout)
        
        btn_layout = QHBoxLayout()
        auto_btn = QPushButton("🤖 AI-автоопределение колонок")
        auto_btn.clicked.connect(self.ai_auto_detect)
        btn_layout.addWidget(auto_btn)
        
        manual_btn = QPushButton("Ручное автоопределение")
        manual_btn.clicked.connect(self.manual_auto_detect)
        btn_layout.addWidget(manual_btn)
        
        btn_layout.addStretch()
        
        ok_btn = QPushButton("OK")
        ok_btn.clicked.connect(self.accept)
        cancel_btn = QPushButton("Отмена")
        cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(ok_btn)
        btn_layout.addWidget(cancel_btn)
        
        layout.addLayout(btn_layout)
        
        self.setLayout(layout)
    
    def ai_auto_detect(self):
        try:
            if self.filepath.endswith('.csv'):
                df = pd.read_csv(self.filepath, encoding='utf-8', nrows=100, dtype=str)
            else:
                df = pd.read_excel(self.filepath, header=None, dtype=str, nrows=100, engine='openpyxl')
            
            if df.empty or len(df.columns) == 0:
                QMessageBox.warning(self, "Ошибка", "Файл пуст или не содержит данных!")
                return
            
            has_headers = False
            headers = []
            data_df = df.copy()
            
            if len(df) > 0:
                first_row = df.iloc[0]
                header_candidates = [str(v).strip() if not pd.isna(v) else '' for v in first_row]
                if header_candidates:
                    is_header = True
                    for val in header_candidates[:5]:
                        if val and validate_mac(val):
                            is_header = False
                            break
                    if is_header:
                        has_headers = True
                        headers = [str(h).strip() if not pd.isna(h) else get_column_letter(i) for i, h in enumerate(first_row)]
                        data_df = df.iloc[1:].reset_index(drop=True)
            
            mapping, candidates = AIColumnDetector.detect_columns_with_ai(data_df, headers, has_headers)
            
            show_conflict_dialog = False
            for col_idx, cand in candidates.items():
                scores = cand['scores']
                top_scores = sorted(scores.values(), reverse=True)
                if len(top_scores) > 1 and top_scores[0] > 0.25 and top_scores[1] > 0.15:
                    show_conflict_dialog = True
                    break
            
            if show_conflict_dialog:
                dialog = ColumnConflictDialog(candidates, headers, has_headers, data_df, self)
                if dialog.exec_():
                    user_mapping = dialog.get_mapping()
                    for field_key, col_letter in user_mapping.items():
                        if field_key == 'mac':
                            mapping['mac_col'] = col_letter
                        elif field_key == 'vendor':
                            mapping['vendor_col'] = col_letter
                        elif field_key == 'model':
                            mapping['model_col'] = col_letter
                        elif field_key == 'address':
                            mapping['address_col'] = col_letter
                        elif field_key == 'ip':
                            mapping['ip_col'] = col_letter
                        elif field_key == 'room':
                            mapping['room_col'] = col_letter
                        elif field_key == 'switch_ip':
                            mapping['switch_ip_col'] = col_letter
                        elif field_key == 'switch_port':
                            mapping['switch_port_col'] = col_letter
            
            if mapping.get('mac_col'):
                self.mac_combo.setCurrentText(mapping['mac_col'])
            if mapping.get('vendor_col'):
                self.vendor_combo.setCurrentText(mapping['vendor_col'])
            if mapping.get('address_col'):
                self.address_combo.setCurrentText(mapping['address_col'])
            if mapping.get('ip_col'):
                self.ip_combo.setCurrentText(mapping['ip_col'])
            if mapping.get('room_col'):
                self.room_combo.setCurrentText(mapping['room_col'])
            if mapping.get('switch_ip_col'):
                self.switch_ip_combo.setCurrentText(mapping['switch_ip_col'])
            if mapping.get('switch_port_col'):
                self.switch_port_combo.setCurrentText(mapping['switch_port_col'])
            
            QMessageBox.information(self, "Готово", "AI-автоопределение колонок выполнено!")
        except Exception as e:
            QMessageBox.warning(self, "Ошибка", f"Ошибка AI-автоопределения: {str(e)}")
    
    def manual_auto_detect(self):
        try:
            if self.filepath.endswith('.csv'):
                df = pd.read_csv(self.filepath, encoding='utf-8', nrows=20, dtype=str)
            else:
                df = pd.read_excel(self.filepath, header=None, dtype=str, nrows=20, engine='openpyxl')
            
            if df.empty or len(df.columns) == 0:
                QMessageBox.warning(self, "Ошибка", "Файл пуст или не содержит данных!")
                return
            
            has_headers = False
            headers = []
            if len(df) > 0:
                first_row = df.iloc[0]
                header_candidates = [str(v).strip() if not pd.isna(v) else '' for v in first_row]
                if header_candidates:
                    is_header = True
                    for val in header_candidates[:5]:
                        if val and validate_mac(val):
                            is_header = False
                            break
                    if is_header:
                        has_headers = True
                        headers = [str(h).strip() if not pd.isna(h) else get_column_letter(i) for i, h in enumerate(first_row)]
                        df = df.iloc[1:]
            
            mapping = AutoColumnDetector.auto_detect_mapping(df, headers, has_headers)
            
            if mapping['mac_col']:
                self.mac_combo.setCurrentText(mapping['mac_col'])
            if mapping['vendor_col']:
                self.vendor_combo.setCurrentText(mapping['vendor_col'])
            if mapping['address_col']:
                self.address_combo.setCurrentText(mapping['address_col'])
            if mapping['ip_col']:
                self.ip_combo.setCurrentText(mapping['ip_col'])
            if mapping['room_col']:
                self.room_combo.setCurrentText(mapping['room_col'])
            if mapping.get('switch_ip_col'):
                self.switch_ip_combo.setCurrentText(mapping['switch_ip_col'])
            if mapping.get('switch_port_col'):
                self.switch_port_combo.setCurrentText(mapping['switch_port_col'])
            
            QMessageBox.information(self, "Готово", "Ручное автоопределение колонок выполнено!")
        except Exception as e:
            QMessageBox.warning(self, "Ошибка", f"Ошибка автоопределения: {str(e)}")
    
    def get_mapping(self):
        return {
            'mac_col': self.mac_combo.currentText(),
            'vendor_col': self.vendor_combo.currentText() if self.vendor_combo.currentText() != 'Не указано' else None,
            'model_col': self.model_combo.currentText() if self.model_combo.currentText() != 'Не указано' else None,
            'address_col': self.address_combo.currentText() if self.address_combo.currentText() != 'Не указано' else None,
            'ip_col': self.ip_combo.currentText() if self.ip_combo.currentText() != 'Не указано' else None,
            'room_col': self.room_combo.currentText() if self.room_combo.currentText() != 'Не указано' else None,
            'switch_ip_col': self.switch_ip_combo.currentText() if self.switch_ip_combo.currentText() != 'Не указано' else None,
            'switch_port_col': self.switch_port_combo.currentText() if self.switch_port_combo.currentText() != 'Не указано' else None
        }


# ==================== ДИАЛОГ СРАВНЕНИЯ НЕСКОЛЬКИХ ФАЙЛОВ ====================

class MultiFileComparisonDialog(QDialog):
    def __init__(self, analyzer, parent=None):
        super().__init__(parent)
        self.analyzer = analyzer
        self.parent_window = parent
        self.files = []
        self.comparison_results = []
        self.setWindowTitle("Сравнение нескольких файлов")
        self.setModal(True)
        self.setGeometry(100, 100, 1400, 800)
        self.setStyleSheet(parent.styleSheet() if parent else "")
        self.init_ui()
    
    def init_ui(self):
        layout = QVBoxLayout()
        
        title = QLabel("Сравнение нескольких файлов")
        title.setFont(QFont("Segoe UI", 16, QFont.Bold))
        layout.addWidget(title)
        
        info_label = QLabel("Добавьте до 10 файлов для сравнения. Будет выполнено попарное сравнение всех файлов.")
        info_label.setWordWrap(True)
        layout.addWidget(info_label)
        
        files_panel = QGroupBox("Файлы для сравнения")
        files_layout = QVBoxLayout()
        
        self.files_list = QListWidget()
        self.files_list.setMaximumHeight(150)
        files_layout.addWidget(self.files_list)
        
        btn_layout = QHBoxLayout()
        add_btn = QPushButton("Добавить файл")
        add_btn.clicked.connect(self.add_file)
        btn_layout.addWidget(add_btn)
        
        remove_btn = QPushButton("Удалить выбранный")
        remove_btn.clicked.connect(self.remove_file)
        btn_layout.addWidget(remove_btn)
        
        clear_btn = QPushButton("Очистить список")
        clear_btn.clicked.connect(self.clear_files)
        btn_layout.addWidget(clear_btn)
        
        btn_layout.addStretch()
        files_layout.addLayout(btn_layout)
        
        files_panel.setLayout(files_layout)
        layout.addWidget(files_panel)
        
        fields_panel = QGroupBox("Поля для сравнения")
        fields_layout = QVBoxLayout()
        
        self.compare_mac_cb = QCheckBox("MAC-адрес (основной ключ)")
        self.compare_mac_cb.setChecked(True)
        fields_layout.addWidget(self.compare_mac_cb)
        
        self.compare_oui_cb = QCheckBox("OUI производителя")
        self.compare_oui_cb.setChecked(True)
        fields_layout.addWidget(self.compare_oui_cb)
        
        self.compare_vendor_cb = QCheckBox("Производитель")
        self.compare_vendor_cb.setChecked(False)
        fields_layout.addWidget(self.compare_vendor_cb)
        
        self.compare_model_cb = QCheckBox("Модель")
        self.compare_model_cb.setChecked(False)
        fields_layout.addWidget(self.compare_model_cb)
        
        self.compare_ip_cb = QCheckBox("IP-адрес")
        self.compare_ip_cb.setChecked(False)
        fields_layout.addWidget(self.compare_ip_cb)
        
        self.compare_address_cb = QCheckBox("Физический адрес")
        self.compare_address_cb.setChecked(False)
        fields_layout.addWidget(self.compare_address_cb)
        
        self.compare_room_cb = QCheckBox("Помещение")
        self.compare_room_cb.setChecked(False)
        fields_layout.addWidget(self.compare_room_cb)
        
        fields_panel.setLayout(fields_layout)
        layout.addWidget(fields_panel)
        
        action_layout = QHBoxLayout()
        self.compare_btn = QPushButton("Сравнить файлы")
        self.compare_btn.clicked.connect(self.compare_files)
        action_layout.addWidget(self.compare_btn)
        
        self.export_all_btn = QPushButton("Экспорт всех результатов")
        self.export_all_btn.clicked.connect(self.export_all_results)
        action_layout.addWidget(self.export_all_btn)
        
        action_layout.addStretch()
        layout.addLayout(action_layout)
        
        results_panel = QGroupBox("Результаты сравнения")
        results_layout = QVBoxLayout()
        
        pair_layout = QHBoxLayout()
        pair_layout.addWidget(QLabel("Показать сравнение:"))
        self.pair_combo = QComboBox()
        self.pair_combo.currentIndexChanged.connect(self.display_comparison)
        pair_layout.addWidget(self.pair_combo)
        pair_layout.addStretch()
        results_layout.addLayout(pair_layout)
        
        self.results_table = QTableWidget()
        self.results_table.setAlternatingRowColors(True)
        results_layout.addWidget(self.results_table)
        
        results_panel.setLayout(results_layout)
        layout.addWidget(results_panel)
        
        self.stats_label = QLabel("")
        self.stats_label.setStyleSheet("padding: 8px; background: #3c3c3c; border-radius: 4px;")
        layout.addWidget(self.stats_label)
        
        close_btn = QPushButton("Закрыть")
        close_btn.clicked.connect(self.accept)
        layout.addWidget(close_btn)
        
        self.setLayout(layout)
    
    def add_file(self):
        if len(self.files) >= 10:
            QMessageBox.warning(self, "Ошибка", "Максимум 10 файлов для сравнения!")
            return
        
        filepath, _ = QFileDialog.getOpenFileName(self, "Выберите файл", "", "Excel Files (*.xlsx *.xls *.csv)")
        if filepath:
            for f in self.files:
                if f['path'] == filepath:
                    QMessageBox.warning(self, "Ошибка", "Этот файл уже добавлен!")
                    return
            
            alias = Path(filepath).stem
            dialog = ComparisonFileMappingDialog(filepath, alias, self)
            if dialog.exec_():
                mapping = dialog.get_mapping()
                devices, errors = self.analyzer.read_excel_chunked(filepath, 0, mapping)
                if devices is None or len(devices) == 0:
                    QMessageBox.warning(self, "Ошибка", f"Не удалось загрузить данные из файла {alias}!\n{errors[0] if errors else ''}")
                    return
                
                self.files.append({
                    'path': filepath,
                    'name': alias,
                    'devices': devices,
                    'mapping': mapping,
                    'count': len(devices)
                })
                
                self.files_list.addItem(f"Файл: {alias} ({len(devices)} устройств)")
                QMessageBox.information(self, "Успех", f"Файл {alias} загружен. Найдено {len(devices)} устройств.")
    
    def remove_file(self):
        current_row = self.files_list.currentRow()
        if current_row >= 0:
            self.files.pop(current_row)
            self.files_list.takeItem(current_row)
            self.pair_combo.clear()
            self.results_table.setRowCount(0)
            self.results_table.setColumnCount(0)
            self.stats_label.setText("")
    
    def clear_files(self):
        self.files.clear()
        self.files_list.clear()
        self.pair_combo.clear()
        self.results_table.setRowCount(0)
        self.results_table.setColumnCount(0)
        self.stats_label.setText("")
    
    def compare_files(self):
        if len(self.files) < 2:
            QMessageBox.warning(self, "Ошибка", "Добавьте минимум 2 файла для сравнения!")
            return
        
        compare_fields = {
            'mac': self.compare_mac_cb.isChecked(),
            'oui': self.compare_oui_cb.isChecked(),
            'vendor': self.compare_vendor_cb.isChecked(),
            'model': self.compare_model_cb.isChecked(),
            'ip': self.compare_ip_cb.isChecked(),
            'address': self.compare_address_cb.isChecked(),
            'room': self.compare_room_cb.isChecked()
        }
        
        progress = QProgressDialog("Сравнение файлов", "Отмена", 0, len(self.files) * len(self.files), self)
        progress.setWindowModality(Qt.WindowModal)
        progress.show()
        
        self.comparison_results = []
        result_index = 0
        
        for i in range(len(self.files)):
            for j in range(len(self.files)):
                if i == j:
                    continue
                
                progress.setValue(result_index)
                progress.setLabelText(f"Сравнение {self.files[i]['name']} ↔ {self.files[j]['name']}")
                QApplication.processEvents()
                
                dict1 = {d['mac']: d for d in self.files[i]['devices']}
                dict2 = {d['mac']: d for d in self.files[j]['devices']}
                all_macs = set(dict1.keys()) | set(dict2.keys())
                
                only_in_1 = []
                only_in_2 = []
                common = []
                
                for mac in all_macs:
                    dev1 = dict1.get(mac)
                    dev2 = dict2.get(mac)
                    
                    if dev1 and not dev2:
                        only_in_1.append(dev1)
                    elif not dev1 and dev2:
                        only_in_2.append(dev2)
                    else:
                        changes = []
                        if compare_fields.get('vendor', False) and dev1.get('vendor') != dev2.get('vendor'):
                            changes.append(f"Производитель: {dev1.get('vendor')} → {dev2.get('vendor')}")
                        if compare_fields.get('model', False) and dev1.get('model') != dev2.get('model'):
                            changes.append(f"Модель: {dev1.get('model')} → {dev2.get('model')}")
                        if compare_fields.get('ip', False) and dev1.get('ip') != dev2.get('ip'):
                            changes.append(f"IP: {dev1.get('ip')} → {dev2.get('ip')}")
                        if compare_fields.get('address', False) and dev1.get('address') != dev2.get('address'):
                            changes.append(f"Адрес: {dev1.get('address')} → {dev2.get('address')}")
                        if compare_fields.get('room', False) and dev1.get('room') != dev2.get('room'):
                            changes.append(f"Помещение: {dev1.get('room')} → {dev2.get('room')}")
                        
                        common.append({
                            'mac': mac,
                            'mac_formatted': dev1.get('mac_formatted', mac),
                            'device1': dev1,
                            'device2': dev2,
                            'changes': changes
                        })
                
                self.comparison_results.append({
                    'file1_name': self.files[i]['name'],
                    'file2_name': self.files[j]['name'],
                    'only_in_1': only_in_1,
                    'only_in_2': only_in_2,
                    'common': common,
                    'stats': {
                        'only_in_1_count': len(only_in_1),
                        'only_in_2_count': len(only_in_2),
                        'common_count': len(common),
                        'changed_count': len([c for c in common if c['changes']]),
                        'identical_count': len([c for c in common if not c['changes']])
                    }
                })
                result_index += 1
        
        progress.close()
        
        self.pair_combo.clear()
        for res in self.comparison_results:
            self.pair_combo.addItem(f"{res['file1_name']} ↔ {res['file2_name']}")
        
        if self.comparison_results:
            self.display_comparison(0)
        
        total_unique = set()
        for f in self.files:
            for d in f['devices']:
                total_unique.add(d['mac'])
        
        stats_text = f"Общая статистика:\n{'-' * 50}\n"
        stats_text += f"Всего файлов: {len(self.files)}\n"
        stats_text += f"Всего уникальных устройств: {len(total_unique)}\n"
        for f in self.files:
            stats_text += f"  • {f['name']}: {f['count']} устройств\n"
        
        self.stats_label.setText(stats_text)
        QMessageBox.information(self, "Сравнение завершено", f"Сравнение {len(self.files)} файлов завершено!\nВсего пар: {len(self.comparison_results)}")
    
    def display_comparison(self, index):
        if index < 0 or index >= len(self.comparison_results):
            return
        
        res = self.comparison_results[index]
        headers = ["MAC-адрес", "Тип", "Было", "Стало", "Изменения"]
        self.results_table.setColumnCount(len(headers))
        self.results_table.setHorizontalHeaderLabels(headers)
        
        total_rows = len(res['only_in_1']) + len(res['only_in_2']) + len(res['common'])
        self.results_table.setRowCount(total_rows)
        row = 0
        
        for dev in res['only_in_1']:
            self.results_table.setItem(row, 0, QTableWidgetItem(dev.get('mac_formatted', dev.get('mac', ''))))
            self.results_table.setItem(row, 1, QTableWidgetItem(f"Только в {res['file1_name']}"))
            self.results_table.setItem(row, 2, QTableWidgetItem(self._format_device_summary(dev)))
            self.results_table.setItem(row, 3, QTableWidgetItem("—"))
            self.results_table.setItem(row, 4, QTableWidgetItem("Устройство отсутствует во втором файле"))
            row += 1
        
        for dev in res['only_in_2']:
            self.results_table.setItem(row, 0, QTableWidgetItem(dev.get('mac_formatted', dev.get('mac', ''))))
            self.results_table.setItem(row, 1, QTableWidgetItem(f"Только в {res['file2_name']}"))
            self.results_table.setItem(row, 2, QTableWidgetItem("—"))
            self.results_table.setItem(row, 3, QTableWidgetItem(self._format_device_summary(dev)))
            self.results_table.setItem(row, 4, QTableWidgetItem("Устройство отсутствует в первом файле"))
            row += 1
        
        for common_dev in res['common']:
            if common_dev['changes']:
                self.results_table.setItem(row, 0, QTableWidgetItem(common_dev['mac_formatted']))
                self.results_table.setItem(row, 1, QTableWidgetItem("Изменено"))
                self.results_table.setItem(row, 2, QTableWidgetItem(self._format_device_summary(common_dev['device1'])))
                self.results_table.setItem(row, 3, QTableWidgetItem(self._format_device_summary(common_dev['device2'])))
                self.results_table.setItem(row, 4, QTableWidgetItem("\n".join(common_dev['changes'][:3])))
            else:
                self.results_table.setItem(row, 0, QTableWidgetItem(common_dev['mac_formatted']))
                self.results_table.setItem(row, 1, QTableWidgetItem("Без изменений"))
                self.results_table.setItem(row, 2, QTableWidgetItem(self._format_device_summary(common_dev['device1'])))
                self.results_table.setItem(row, 3, QTableWidgetItem(self._format_device_summary(common_dev['device2'])))
                self.results_table.setItem(row, 4, QTableWidgetItem("Данные совпадают"))
            row += 1
        
        self.results_table.resizeColumnsToContents()
        self.results_table.horizontalHeader().setStretchLastSection(True)
    
    def _format_device_summary(self, dev):
        parts = []
        if dev.get('vendor') and dev['vendor'] != 'Unknown':
            parts.append(f"Произв: {dev['vendor']}")
        if dev.get('model'):
            parts.append(f"Модель: {dev['model']}")
        if dev.get('ip'):
            parts.append(f"IP: {dev['ip']}")
        if dev.get('address'):
            parts.append(f"Адрес: {dev['address']}")
        if dev.get('room'):
            parts.append(f"Помещ: {dev['room']}")
        if dev.get('switch_ip'):
            parts.append(f"Комм: {dev['switch_ip']}")
        if dev.get('switch_port'):
            parts.append(f"Порт: {dev['switch_port']}")
        return "; ".join(parts) if parts else "Нет данных"
    
    def export_all_results(self):
        if not self.comparison_results:
            QMessageBox.warning(self, "Ошибка", "Нет результатов для экспорта! Сначала выполните сравнение.")
            return
        
        filename, _ = QFileDialog.getSaveFileName(self, "Сохранить результаты сравнения",
                                                   f"multi_comparison_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx",
                                                   "Excel Files (*.xlsx)")
        if filename:
            try:
                with pd.ExcelWriter(filename, engine='openpyxl') as writer:
                    stats_data = []
                    for f in self.files:
                        stats_data.append({'Файл': f['name'], 'Устройств': f['count']})
                    df_stats = pd.DataFrame(stats_data)
                    df_stats.to_excel(writer, sheet_name='Общая статистика', index=False)
                    
                    for idx, res in enumerate(self.comparison_results):
                        sheet_name = f"{res['file1_name']}_vs_{res['file2_name']}"[:31]
                        data = []
                        
                        for dev in res['only_in_1']:
                            data.append({
                                'MAC': dev.get('mac_formatted', dev.get('mac', '')),
                                'Тип': f'Только в {res["file1_name"]}',
                                'Значение_файл1': self._format_device_summary(dev),
                                'Значение_файл2': '',
                                'Изменения': 'Устройство отсутствует во втором файле'
                            })
                        
                        for dev in res['only_in_2']:
                            data.append({
                                'MAC': dev.get('mac_formatted', dev.get('mac', '')),
                                'Тип': f'Только в {res["file2_name"]}',
                                'Значение_файл1': '',
                                'Значение_файл2': self._format_device_summary(dev),
                                'Изменения': 'Устройство отсутствует в первом файле'
                            })
                        
                        for common_dev in res['common']:
                            if common_dev['changes']:
                                data.append({
                                    'MAC': common_dev['mac_formatted'],
                                    'Тип': 'Изменено',
                                    'Значение_файл1': self._format_device_summary(common_dev['device1']),
                                    'Значение_файл2': self._format_device_summary(common_dev['device2']),
                                    'Изменения': "\n".join(common_dev['changes'])
                                })
                            else:
                                data.append({
                                    'MAC': common_dev['mac_formatted'],
                                    'Тип': 'Без изменений',
                                    'Значение_файл1': self._format_device_summary(common_dev['device1']),
                                    'Значение_файл2': self._format_device_summary(common_dev['device2']),
                                    'Изменения': 'Данные совпадают'
                                })
                        
                        if data:
                            df = pd.DataFrame(data)
                            df.to_excel(writer, sheet_name=sheet_name, index=False)
                        
                        stats_pair_data = [
                            {'Показатель': 'Устройств только в первом файле', 'Значение': res['stats']['only_in_1_count']},
                            {'Показатель': 'Устройств только во втором файле', 'Значение': res['stats']['only_in_2_count']},
                            {'Показатель': 'Общих устройств', 'Значение': res['stats']['common_count']},
                            {'Показатель': 'Измененных устройств', 'Значение': res['stats']['changed_count']},
                            {'Показатель': 'Совпадающих устройств', 'Значение': res['stats']['identical_count']}
                        ]
                        df_stats_pair = pd.DataFrame(stats_pair_data)
                        df_stats_pair.to_excel(writer, sheet_name=f"{sheet_name[:27]}_стат", index=False)
                
                QMessageBox.information(self, "Успех", f"Результаты сохранены в {filename}")
            except Exception as e:
                QMessageBox.warning(self, "Ошибка", f"Ошибка при экспорте: {str(e)}")


# ==================== ДИАЛОГ ВЫБОРА ПОЛЕЙ ====================

class FieldsSelectionDialog(QDialog):
    def __init__(self, comparison_fields=None, enrich_fields=None, parent=None):
        super().__init__(parent)
        self.comparison_fields = comparison_fields or {
            'compare_mac': True, 'compare_oui': True, 'compare_vendor': False,
            'compare_model': False, 'compare_ip': False, 'compare_address': False, 
            'compare_room': False, 'compare_switch_ip': False, 'compare_switch_port': False
        }
        self.enrich_fields = enrich_fields or {
            'model': True, 'address': True, 'ip': True, 'vendor': True, 
            'room': True, 'switch_ip': True, 'switch_port': True
        }
        self.setWindowTitle("Настройка полей")
        self.setModal(True)
        self.setGeometry(300, 300, 550, 700)
        self.setStyleSheet(parent.styleSheet() if parent else "")
        self.init_ui()
    
    def init_ui(self):
        layout = QVBoxLayout()
        title = QLabel("Настройка полей для сравнения и обогащения")
        title.setFont(QFont("Segoe UI", 14, QFont.Bold))
        layout.addWidget(title)
        info_label = QLabel("Выберите, какие поля будут использоваться при сравнении и обогащении данных.\n"
                           "⚠️ Данные из файла имеют наивысший приоритет и не перезаписываются.")
        info_label.setWordWrap(True)
        layout.addWidget(info_label)
        
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll_widget = QWidget()
        scroll_layout = QVBoxLayout(scroll_widget)
        
        compare_group = QGroupBox("Поля для сравнения (поиск соответствий)")
        compare_layout = QVBoxLayout()
        self.compare_mac = QCheckBox("MAC-адрес (точное совпадение)")
        self.compare_mac.setChecked(self.comparison_fields.get('compare_mac', True))
        self.compare_oui = QCheckBox("OUI (первые байты MAC)")
        self.compare_oui.setChecked(self.comparison_fields.get('compare_oui', True))
        self.compare_vendor = QCheckBox("Производитель")
        self.compare_vendor.setChecked(self.comparison_fields.get('compare_vendor', False))
        self.compare_model = QCheckBox("Модель устройства")
        self.compare_model.setChecked(self.comparison_fields.get('compare_model', False))
        self.compare_ip = QCheckBox("IP-адрес")
        self.compare_ip.setChecked(self.comparison_fields.get('compare_ip', False))
        self.compare_address = QCheckBox("Физический адрес")
        self.compare_address.setChecked(self.comparison_fields.get('compare_address', False))
        self.compare_room = QCheckBox("Помещение")
        self.compare_room.setChecked(self.comparison_fields.get('compare_room', False))
        self.compare_switch_ip = QCheckBox("IP коммутатора")
        self.compare_switch_ip.setChecked(self.comparison_fields.get('compare_switch_ip', False))
        self.compare_switch_port = QCheckBox("Порт подключения")
        self.compare_switch_port.setChecked(self.comparison_fields.get('compare_switch_port', False))
        compare_layout.addWidget(self.compare_mac)
        compare_layout.addWidget(self.compare_oui)
        compare_layout.addWidget(self.compare_vendor)
        compare_layout.addWidget(self.compare_model)
        compare_layout.addWidget(self.compare_ip)
        compare_layout.addWidget(self.compare_address)
        compare_layout.addWidget(self.compare_room)
        compare_layout.addWidget(self.compare_switch_ip)
        compare_layout.addWidget(self.compare_switch_port)
        compare_group.setLayout(compare_layout)
        scroll_layout.addWidget(compare_group)
        
        enrich_group = QGroupBox("Поля для обогащения (добавление данных)")
        enrich_layout = QVBoxLayout()
        self.enrich_model = QCheckBox("Модель устройства")
        self.enrich_model.setChecked(self.enrich_fields.get('model', True))
        self.enrich_address = QCheckBox("Физический адрес/локация")
        self.enrich_address.setChecked(self.enrich_fields.get('address', True))
        self.enrich_ip = QCheckBox("IP-адрес")
        self.enrich_ip.setChecked(self.enrich_fields.get('ip', True))
        self.enrich_vendor = QCheckBox("Производитель (если неизвестен)")
        self.enrich_vendor.setChecked(self.enrich_fields.get('vendor', True))
        self.enrich_room = QCheckBox("Помещение")
        self.enrich_room.setChecked(self.enrich_fields.get('room', True))
        self.enrich_switch_ip = QCheckBox("IP коммутатора")
        self.enrich_switch_ip.setChecked(self.enrich_fields.get('switch_ip', True))
        self.enrich_switch_port = QCheckBox("Порт подключения")
        self.enrich_switch_port.setChecked(self.enrich_fields.get('switch_port', True))
        enrich_layout.addWidget(self.enrich_model)
        enrich_layout.addWidget(self.enrich_address)
        enrich_layout.addWidget(self.enrich_ip)
        enrich_layout.addWidget(self.enrich_vendor)
        enrich_layout.addWidget(self.enrich_room)
        enrich_layout.addWidget(self.enrich_switch_ip)
        enrich_layout.addWidget(self.enrich_switch_port)
        enrich_group.setLayout(enrich_layout)
        scroll_layout.addWidget(enrich_group)
        
        threshold_group = QGroupBox("Порог схожести для нечеткого сравнения")
        threshold_layout = QVBoxLayout()
        self.threshold_slider = QSlider(Qt.Horizontal)
        self.threshold_slider.setRange(0, 100)
        self.threshold_slider.setValue(self.comparison_fields.get('threshold', 70))
        self.threshold_slider.setTickInterval(10)
        threshold_layout.addWidget(self.threshold_slider)
        self.threshold_label = QLabel(f"Порог: {self.comparison_fields.get('threshold', 70)}%")
        threshold_layout.addWidget(self.threshold_label)
        self.threshold_slider.valueChanged.connect(lambda v: self.threshold_label.setText(f"Порог: {v}%"))
        threshold_group.setLayout(threshold_layout)
        scroll_layout.addWidget(threshold_group)
        
        scroll_layout.addStretch()
        scroll.setWidget(scroll_widget)
        layout.addWidget(scroll)
        
        btn_layout = QHBoxLayout()
        select_all_btn = QPushButton("Выбрать все поля для сравнения")
        select_all_btn.clicked.connect(self.select_all_compare)
        btn_layout.addWidget(select_all_btn)
        deselect_all_btn = QPushButton("Снять все для сравнения")
        deselect_all_btn.clicked.connect(self.deselect_all_compare)
        btn_layout.addWidget(deselect_all_btn)
        layout.addLayout(btn_layout)
        
        btn_layout2 = QHBoxLayout()
        select_enrich_all_btn = QPushButton("Выбрать все для обогащения")
        select_enrich_all_btn.clicked.connect(self.select_all_enrich)
        btn_layout2.addWidget(select_enrich_all_btn)
        deselect_enrich_all_btn = QPushButton("Снять все для обогащения")
        deselect_enrich_all_btn.clicked.connect(self.deselect_all_enrich)
        btn_layout2.addWidget(deselect_enrich_all_btn)
        layout.addLayout(btn_layout2)
        
        button_box = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        button_box.accepted.connect(self.accept)
        button_box.rejected.connect(self.reject)
        layout.addWidget(button_box)
        self.setLayout(layout)
    
    def select_all_compare(self):
        self.compare_mac.setChecked(True)
        self.compare_oui.setChecked(True)
        self.compare_vendor.setChecked(True)
        self.compare_model.setChecked(True)
        self.compare_ip.setChecked(True)
        self.compare_address.setChecked(True)
        self.compare_room.setChecked(True)
        self.compare_switch_ip.setChecked(True)
        self.compare_switch_port.setChecked(True)
    
    def deselect_all_compare(self):
        self.compare_mac.setChecked(False)
        self.compare_oui.setChecked(False)
        self.compare_vendor.setChecked(False)
        self.compare_model.setChecked(False)
        self.compare_ip.setChecked(False)
        self.compare_address.setChecked(False)
        self.compare_room.setChecked(False)
        self.compare_switch_ip.setChecked(False)
        self.compare_switch_port.setChecked(False)
    
    def select_all_enrich(self):
        self.enrich_model.setChecked(True)
        self.enrich_address.setChecked(True)
        self.enrich_ip.setChecked(True)
        self.enrich_vendor.setChecked(True)
        self.enrich_room.setChecked(True)
        self.enrich_switch_ip.setChecked(True)
        self.enrich_switch_port.setChecked(True)
    
    def deselect_all_enrich(self):
        self.enrich_model.setChecked(False)
        self.enrich_address.setChecked(False)
        self.enrich_ip.setChecked(False)
        self.enrich_vendor.setChecked(False)
        self.enrich_room.setChecked(False)
        self.enrich_switch_ip.setChecked(False)
        self.enrich_switch_port.setChecked(False)
    
    def get_settings(self):
        return {
            'comparison_fields': {
                'compare_mac': self.compare_mac.isChecked(),
                'compare_oui': self.compare_oui.isChecked(),
                'compare_vendor': self.compare_vendor.isChecked(),
                'compare_model': self.compare_model.isChecked(),
                'compare_ip': self.compare_ip.isChecked(),
                'compare_address': self.compare_address.isChecked(),
                'compare_room': self.compare_room.isChecked(),
                'compare_switch_ip': self.compare_switch_ip.isChecked(),
                'compare_switch_port': self.compare_switch_port.isChecked(),
                'threshold': self.threshold_slider.value()
            },
            'enrich_fields': {
                'model': self.enrich_model.isChecked(),
                'address': self.enrich_address.isChecked(),
                'ip': self.enrich_ip.isChecked(),
                'vendor': self.enrich_vendor.isChecked(),
                'room': self.enrich_room.isChecked(),
                'switch_ip': self.enrich_switch_ip.isChecked(),
                'switch_port': self.enrich_switch_port.isChecked()
            }
        }


# ==================== ДИАЛОГ СРАВНЕНИЯ ДВУХ ФАЙЛОВ ====================

class FileComparisonDialog(QDialog):
    def __init__(self, enricher, analyzer, oui_formats=None, parent=None):
        super().__init__(parent)
        self.enricher = enricher
        self.analyzer = analyzer
        self.parent_window = parent
        self.oui_formats = oui_formats or {3: True, 4: False, 5: False, 6: False}
        self.setWindowTitle("Сравнение двух файлов")
        self.setModal(True)
        self.setGeometry(100, 100, 1600, 900)
        self.setStyleSheet(parent.styleSheet() if parent else "")
        
        self.devices1 = []
        self.devices2 = []
        self.file1_path = None
        self.file2_path = None
        self.file1_name = None
        self.file2_name = None
        self.file1_mapping = {}
        self.file2_mapping = {}
        self.all_changes = []
        self.added_changes = []
        self.removed_changes = []
        self.modified_changes = []
        self.current_section = "all"
        
        self.init_ui()
    
    def init_ui(self):
        layout = QVBoxLayout()
        
        title_layout = QHBoxLayout()
        title = QLabel("Сравнение двух файлов")
        title.setFont(QFont("Segoe UI", 16, QFont.Bold))
        title_layout.addWidget(title)
        title_layout.addStretch()
        
        formats_text = self._get_formats_text()
        self.oui_formats_btn = QPushButton(f"Форматы OUI: {formats_text}")
        self.oui_formats_btn.clicked.connect(self.change_oui_formats)
        title_layout.addWidget(self.oui_formats_btn)
        
        layout.addLayout(title_layout)
        
        files_panel = QGroupBox("Выбор файлов для сравнения")
        files_layout = QHBoxLayout()
        
        file1_group = QGroupBox("Файл 1 (базовый)")
        file1_layout = QVBoxLayout()
        self.file1_combo = QComboBox()
        self.file1_combo.setEditable(True)
        file1_layout.addWidget(QLabel("Файл:"))
        file1_layout.addWidget(self.file1_combo)
        
        file1_btn_layout = QHBoxLayout()
        self.file1_browse_btn = QPushButton("Обзор")
        self.file1_browse_btn.clicked.connect(lambda: self.browse_file(1))
        file1_btn_layout.addWidget(self.file1_browse_btn)
        self.file1_configure_btn = QPushButton("Настройка колонок")
        self.file1_configure_btn.clicked.connect(lambda: self.configure_file_columns(1))
        self.file1_configure_btn.setEnabled(False)
        file1_btn_layout.addWidget(self.file1_configure_btn)
        file1_layout.addLayout(file1_btn_layout)
        
        self.file1_load_btn = QPushButton("Загрузить файл 1")
        self.file1_load_btn.clicked.connect(lambda: self.load_file(1))
        file1_layout.addWidget(self.file1_load_btn)
        self.file1_status_label = QLabel("Файл не загружен")
        self.file1_status_label.setStyleSheet("color: #ff6b6b;")
        file1_layout.addWidget(self.file1_status_label)
        file1_group.setLayout(file1_layout)
        files_layout.addWidget(file1_group)
        
        file2_group = QGroupBox("Файл 2 (сравниваемый)")
        file2_layout = QVBoxLayout()
        self.file2_combo = QComboBox()
        self.file2_combo.setEditable(True)
        file2_layout.addWidget(QLabel("Файл:"))
        file2_layout.addWidget(self.file2_combo)
        
        file2_btn_layout = QHBoxLayout()
        self.file2_browse_btn = QPushButton("Обзор")
        self.file2_browse_btn.clicked.connect(lambda: self.browse_file(2))
        file2_btn_layout.addWidget(self.file2_browse_btn)
        self.file2_configure_btn = QPushButton("Настройка колонок")
        self.file2_configure_btn.clicked.connect(lambda: self.configure_file_columns(2))
        self.file2_configure_btn.setEnabled(False)
        file2_btn_layout.addWidget(self.file2_configure_btn)
        file2_layout.addLayout(file2_btn_layout)
        
        self.file2_load_btn = QPushButton("Загрузить файл 2")
        self.file2_load_btn.clicked.connect(lambda: self.load_file(2))
        file2_layout.addWidget(self.file2_load_btn)
        self.file2_status_label = QLabel("Файл не загружен")
        self.file2_status_label.setStyleSheet("color: #ff6b6b;")
        file2_layout.addWidget(self.file2_status_label)
        file2_group.setLayout(file2_layout)
        files_layout.addWidget(file2_group)
        
        files_panel.setLayout(files_layout)
        layout.addWidget(files_panel)
        
        fields_panel = QGroupBox("Поля для сравнения")
        fields_layout = QHBoxLayout()
        self.compare_mac_cb = QCheckBox("MAC-адрес")
        self.compare_mac_cb.setChecked(True)
        fields_layout.addWidget(self.compare_mac_cb)
        self.compare_vendor_cb = QCheckBox("Производитель")
        self.compare_vendor_cb.setChecked(True)
        fields_layout.addWidget(self.compare_vendor_cb)
        self.compare_model_cb = QCheckBox("Модель")
        self.compare_model_cb.setChecked(True)
        fields_layout.addWidget(self.compare_model_cb)
        self.compare_ip_cb = QCheckBox("IP-адрес")
        self.compare_ip_cb.setChecked(True)
        fields_layout.addWidget(self.compare_ip_cb)
        self.compare_address_cb = QCheckBox("Адрес")
        self.compare_address_cb.setChecked(True)
        fields_layout.addWidget(self.compare_address_cb)
        self.compare_room_cb = QCheckBox("Помещение")
        self.compare_room_cb.setChecked(True)
        fields_layout.addWidget(self.compare_room_cb)
        self.compare_switch_ip_cb = QCheckBox("IP коммутатора")
        self.compare_switch_ip_cb.setChecked(True)
        fields_layout.addWidget(self.compare_switch_ip_cb)
        self.compare_switch_port_cb = QCheckBox("Порт")
        self.compare_switch_port_cb.setChecked(True)
        fields_layout.addWidget(self.compare_switch_port_cb)
        fields_layout.addStretch()
        fields_panel.setLayout(fields_layout)
        layout.addWidget(fields_panel)
        
        self.file_info_label = QLabel("Выберите и настройте файлы для сравнения")
        self.file_info_label.setStyleSheet("background: #3c3c3c; padding: 8px; border-radius: 4px;")
        layout.addWidget(self.file_info_label)
        
        nav_panel = QWidget()
        nav_layout = QHBoxLayout(nav_panel)
        nav_layout.setSpacing(10)
        self.all_btn = QPushButton("Все изменения")
        self.all_btn.clicked.connect(lambda: self.switch_section("all"))
        nav_layout.addWidget(self.all_btn)
        self.added_btn = QPushButton("Добавленные")
        self.added_btn.clicked.connect(lambda: self.switch_section("added"))
        nav_layout.addWidget(self.added_btn)
        self.removed_btn = QPushButton("Удаленные")
        self.removed_btn.clicked.connect(lambda: self.switch_section("removed"))
        nav_layout.addWidget(self.removed_btn)
        self.modified_btn = QPushButton("Измененные")
        self.modified_btn.clicked.connect(lambda: self.switch_section("modified"))
        nav_layout.addWidget(self.modified_btn)
        nav_layout.addStretch()
        layout.addWidget(nav_panel)
        
        self.stats_label = QLabel("")
        self.stats_label.setStyleSheet("padding: 8px; background: #3c3c3c; border-radius: 4px;")
        layout.addWidget(self.stats_label)
        
        self.changes_table = QTableWidget()
        self.changes_table.setAlternatingRowColors(True)
        self.update_table_headers()
        layout.addWidget(self.changes_table)
        
        export_layout = QHBoxLayout()
        export_excel_btn = QPushButton("Экспорт в Excel")
        export_excel_btn.clicked.connect(self.export_to_excel)
        export_layout.addWidget(export_excel_btn)
        export_csv_btn = QPushButton("Экспорт в CSV")
        export_csv_btn.clicked.connect(self.export_to_csv)
        export_layout.addWidget(export_csv_btn)
        export_txt_btn = QPushButton("Экспорт в TXT")
        export_txt_btn.clicked.connect(self.export_to_txt)
        export_layout.addWidget(export_txt_btn)
        compare_btn = QPushButton("Сравнить")
        compare_btn.clicked.connect(self.compare)
        export_layout.addWidget(compare_btn)
        
        layout.addLayout(export_layout)
        
        button_box = QDialogButtonBox(QDialogButtonBox.Close)
        button_box.rejected.connect(self.accept)
        layout.addWidget(button_box)
        
        self.setLayout(layout)
        self.update_file_lists()
    
    def update_file_lists(self):
        files = list(self.enricher.files.keys())
        self.file1_combo.clear()
        self.file2_combo.clear()
        for f in files:
            self.file1_combo.addItem(f)
            self.file2_combo.addItem(f)
    
    def browse_file(self, file_num):
        f, _ = QFileDialog.getOpenFileName(self, "Выберите файл", "", "Excel Files (*.xlsx *.xls *.csv)")
        if f:
            if file_num == 1:
                self.file1_combo.setEditText(f)
                self.file1_status_label.setText("Файл выбран, настройте колонки")
                self.file1_status_label.setStyleSheet("color: #ffab40;")
                self.file1_configure_btn.setEnabled(True)
            else:
                self.file2_combo.setEditText(f)
                self.file2_status_label.setText("Файл выбран, настройте колонки")
                self.file2_status_label.setStyleSheet("color: #ffab40;")
                self.file2_configure_btn.setEnabled(True)
    
    def configure_file_columns(self, file_num):
        if file_num == 1:
            file_spec = self.file1_combo.currentText()
            if not file_spec:
                QMessageBox.warning(self, "Ошибка", "Сначала выберите файл!")
                return
            
            if os.path.exists(file_spec):
                filepath = file_spec
            elif file_spec in self.enricher.files:
                filepath = self.enricher.files[file_spec]['path']
            else:
                QMessageBox.warning(self, "Ошибка", f"Файл '{file_spec}' не найден!")
                return
            
            alias = Path(filepath).stem
            dialog = ComparisonFileMappingDialog(filepath, alias, self)
            if dialog.exec_():
                self.file1_mapping = dialog.get_mapping()
                self.file1_path = filepath
                self.file1_name = alias
                self.file1_status_label.setText(f"Колонки настроены: MAC={self.file1_mapping.get('mac_col', 'A')}")
                self.file1_status_label.setStyleSheet("color: #4CAF50;")
        else:
            file_spec = self.file2_combo.currentText()
            if not file_spec:
                QMessageBox.warning(self, "Ошибка", "Сначала выберите файл!")
                return
            
            if os.path.exists(file_spec):
                filepath = file_spec
            elif file_spec in self.enricher.files:
                filepath = self.enricher.files[file_spec]['path']
            else:
                QMessageBox.warning(self, "Ошибка", f"Файл '{file_spec}' не найден!")
                return
            
            alias = Path(filepath).stem
            dialog = ComparisonFileMappingDialog(filepath, alias, self)
            if dialog.exec_():
                self.file2_mapping = dialog.get_mapping()
                self.file2_path = filepath
                self.file2_name = alias
                self.file2_status_label.setText(f"Колонки настроены: MAC={self.file2_mapping.get('mac_col', 'A')}")
                self.file2_status_label.setStyleSheet("color: #4CAF50;")
    
    def load_file(self, file_num):
        if file_num == 1:
            if not self.file1_path:
                QMessageBox.warning(self, "Ошибка", "Сначала выберите и настройте файл 1!")
                return
            
            devices, errors = self.analyzer.read_excel_chunked(self.file1_path, 0, self.file1_mapping)
            if devices is None:
                QMessageBox.warning(self, "Ошибка", f"Не удалось загрузить файл {self.file1_name}!\n{errors[0] if errors else ''}")
                return
            
            self.devices1 = devices
            self.file1_status_label.setText(f"Загружено: {len(devices)} устройств")
            self.file1_status_label.setStyleSheet("color: #4CAF50;")
            QMessageBox.information(self, "Успех", f"Загружено {len(devices)} устройств из {self.file1_name}")
        else:
            if not self.file2_path:
                QMessageBox.warning(self, "Ошибка", "Сначала выберите и настройте файл 2!")
                return
            
            devices, errors = self.analyzer.read_excel_chunked(self.file2_path, 0, self.file2_mapping)
            if devices is None:
                QMessageBox.warning(self, "Ошибка", f"Не удалось загрузить файл {self.file2_name}!\n{errors[0] if errors else ''}")
                return
            
            self.devices2 = devices
            self.file2_status_label.setText(f"Загружено: {len(devices)} устройств")
            self.file2_status_label.setStyleSheet("color: #4CAF50;")
            QMessageBox.information(self, "Успех", f"Загружено {len(devices)} устройств из {self.file2_name}")
        
        self.update_file_info()
    
    def update_file_info(self):
        info = f"Файл 1: {self.file1_name if self.file1_name else 'Не выбран'} ({len(self.devices1)} устройств) | "
        info += f"Файл 2: {self.file2_name if self.file2_name else 'Не выбран'} ({len(self.devices2)} устройств)"
        self.file_info_label.setText(info)
    
    def switch_section(self, section):
        self.current_section = section
        if section == "all":
            self.populate_table(self.all_changes)
        elif section == "added":
            self.populate_table(self.added_changes)
        elif section == "removed":
            self.populate_table(self.removed_changes)
        elif section == "modified":
            self.populate_table(self.modified_changes)
    
    def populate_table(self, changes):
        self.changes_table.setRowCount(len(changes))
        for i, change in enumerate(changes):
            col = 0
            self.changes_table.setItem(i, col, QTableWidgetItem(change['mac_display']))
            col += 1
            type_text = self._get_type_display(change['type'])
            self.changes_table.setItem(i, col, QTableWidgetItem(type_text))
            col += 1
            
            for length in [3, 4, 5, 6]:
                if self.oui_formats.get(length, False):
                    self.changes_table.setItem(i, col, QTableWidgetItem(change['oui_values'].get(length, '-')))
                    col += 1
            
            self.changes_table.setItem(i, col, QTableWidgetItem(str(change.get('old_vendor', '-'))))
            self.changes_table.setItem(i, col + 1, QTableWidgetItem(str(change.get('new_vendor', '-'))))
            col += 2
            self.changes_table.setItem(i, col, QTableWidgetItem(str(change.get('old_model', '-'))))
            self.changes_table.setItem(i, col + 1, QTableWidgetItem(str(change.get('new_model', '-'))))
            col += 2
            self.changes_table.setItem(i, col, QTableWidgetItem(str(change.get('old_ip', '-'))))
            self.changes_table.setItem(i, col + 1, QTableWidgetItem(str(change.get('new_ip', '-'))))
            col += 2
            self.changes_table.setItem(i, col, QTableWidgetItem(str(change.get('old_address', '-'))))
            self.changes_table.setItem(i, col + 1, QTableWidgetItem(str(change.get('new_address', '-'))))
            col += 2
            self.changes_table.setItem(i, col, QTableWidgetItem(str(change.get('old_room', '-'))))
            self.changes_table.setItem(i, col + 1, QTableWidgetItem(str(change.get('new_room', '-'))))
            col += 2
            self.changes_table.setItem(i, col, QTableWidgetItem(str(change.get('old_switch_ip', '-'))))
            self.changes_table.setItem(i, col + 1, QTableWidgetItem(str(change.get('new_switch_ip', '-'))))
            col += 2
            self.changes_table.setItem(i, col, QTableWidgetItem(str(change.get('old_switch_port', '-'))))
            self.changes_table.setItem(i, col + 1, QTableWidgetItem(str(change.get('new_switch_port', '-'))))
            col += 2
            self.changes_table.setItem(i, col, QTableWidgetItem(change['description']))
        
        self.changes_table.resizeColumnsToContents()
    
    def _get_formats_text(self):
        formats = []
        if self.oui_formats.get(3, False): formats.append("3")
        if self.oui_formats.get(4, False): formats.append("4")
        if self.oui_formats.get(5, False): formats.append("5")
        if self.oui_formats.get(6, False): formats.append("6")
        return f"{'+'.join(formats)} байт" if formats else "не выбраны"
    
    def change_oui_formats(self):
        dialog = OUIFormatSelectionDialog(self.oui_formats, self)
        if dialog.exec_():
            self.oui_formats = dialog.get_selected_formats()
            self.oui_formats_btn.setText(f"Форматы OUI: {self._get_formats_text()}")
            self.update_table_headers()
            if self.devices1 and self.devices2:
                self.compare()
    
    def update_table_headers(self):
        headers = ["MAC-адрес", "Тип изменения"]
        if self.oui_formats.get(3, False):
            headers.append("OUI (3 байта)")
        if self.oui_formats.get(4, False):
            headers.append("OUI (4 байта)")
        if self.oui_formats.get(5, False):
            headers.append("OUI (5 байт)")
        if self.oui_formats.get(6, False):
            headers.append("OUI (6 байт)")
        headers.extend([
            "Производитель (было)", "Производитель (стало)",
            "Модель (было)", "Модель (стало)",
            "IP-адрес (было)", "IP-адрес (стало)",
            "Адрес (было)", "Адрес (стало)",
            "Помещение (было)", "Помещение (стало)",
            "IP коммутатора (было)", "IP коммутатора (стало)",
            "Порт (было)", "Порт (стало)",
            "Описание"
        ])
        self.changes_table.setColumnCount(len(headers))
        self.changes_table.setHorizontalHeaderLabels(headers)
        self.changes_table.horizontalHeader().setStretchLastSection(True)
    
    def compare(self):
        if not self.devices1:
            QMessageBox.warning(self, "Ошибка", "Загрузите файл 1!")
            return
        if not self.devices2:
            QMessageBox.warning(self, "Ошибка", "Загрузите файл 2!")
            return
        
        compare_fields = {
            'mac': self.compare_mac_cb.isChecked(),
            'vendor': self.compare_vendor_cb.isChecked(),
            'model': self.compare_model_cb.isChecked(),
            'ip': self.compare_ip_cb.isChecked(),
            'address': self.compare_address_cb.isChecked(),
            'room': self.compare_room_cb.isChecked(),
            'switch_ip': self.compare_switch_ip_cb.isChecked(),
            'switch_port': self.compare_switch_port_cb.isChecked()
        }
        
        dict1 = {d['mac']: d for d in self.devices1}
        dict2 = {d['mac']: d for d in self.devices2}
        all_macs = set(dict1.keys()) | set(dict2.keys())
        
        self.all_changes = []
        self.added_changes = []
        self.removed_changes = []
        self.modified_changes = []
        
        for mac in all_macs:
            dev1 = dict1.get(mac)
            dev2 = dict2.get(mac)
            mac_display = f"{mac[:2]}:{mac[2:4]}:{mac[4:6]}:{mac[6:8]}:{mac[8:10]}:{mac[10:]}" if len(mac) >= 12 else mac
            
            oui_values = {}
            for length, enabled in self.oui_formats.items():
                if enabled:
                    oui = extract_oui(mac, length)
                    oui_values[length] = format_oui(oui, length) if oui else '-'
            
            if dev1 and not dev2:
                change = {
                    'mac': mac, 'mac_display': mac_display, 'oui_values': oui_values, 'type': 'removed',
                    'old_vendor': dev1.get('vendor', '-'), 'new_vendor': '-',
                    'old_model': dev1.get('model', '-'), 'new_model': '-',
                    'old_ip': dev1.get('ip', '-'), 'new_ip': '-',
                    'old_address': dev1.get('address', '-'), 'new_address': '-',
                    'old_room': dev1.get('room', '-'), 'new_room': '-',
                    'old_switch_ip': dev1.get('switch_ip', '-'), 'new_switch_ip': '-',
                    'old_switch_port': dev1.get('switch_port', '-'), 'new_switch_port': '-',
                    'description': "Устройство удалено из файла 2"
                }
                self.all_changes.append(change)
                self.removed_changes.append(change)
            elif not dev1 and dev2:
                change = {
                    'mac': mac, 'mac_display': mac_display, 'oui_values': oui_values, 'type': 'added',
                    'old_vendor': '-', 'new_vendor': dev2.get('vendor', '-'),
                    'old_model': '-', 'new_model': dev2.get('model', '-'),
                    'old_ip': '-', 'new_ip': dev2.get('ip', '-'),
                    'old_address': '-', 'new_address': dev2.get('address', '-'),
                    'old_room': '-', 'new_room': dev2.get('room', '-'),
                    'old_switch_ip': '-', 'new_switch_ip': dev2.get('switch_ip', '-'),
                    'old_switch_port': '-', 'new_switch_port': dev2.get('switch_port', '-'),
                    'description': "Новое устройство добавлено в файле 2"
                }
                self.all_changes.append(change)
                self.added_changes.append(change)
            else:
                changes_detected = []
                if compare_fields.get('vendor', False) and dev1.get('vendor', '-') != dev2.get('vendor', '-'):
                    changes_detected.append(f"Производитель: {dev1.get('vendor', '-')} → {dev2.get('vendor', '-')}")
                if compare_fields.get('model', False) and dev1.get('model', '-') != dev2.get('model', '-'):
                    changes_detected.append(f"Модель: {dev1.get('model', '-')} → {dev2.get('model', '-')}")
                if compare_fields.get('ip', False) and dev1.get('ip', '-') != dev2.get('ip', '-'):
                    changes_detected.append(f"IP: {dev1.get('ip', '-')} → {dev2.get('ip', '-')}")
                if compare_fields.get('address', False) and dev1.get('address', '-') != dev2.get('address', '-'):
                    changes_detected.append(f"Адрес: {dev1.get('address', '-')} → {dev2.get('address', '-')}")
                if compare_fields.get('room', False) and dev1.get('room', '-') != dev2.get('room', '-'):
                    changes_detected.append(f"Помещение: {dev1.get('room', '-')} → {dev2.get('room', '-')}")
                if compare_fields.get('switch_ip', False) and dev1.get('switch_ip', '-') != dev2.get('switch_ip', '-'):
                    changes_detected.append(f"IP коммутатора: {dev1.get('switch_ip', '-')} → {dev2.get('switch_ip', '-')}")
                if compare_fields.get('switch_port', False) and dev1.get('switch_port', '-') != dev2.get('switch_port', '-'):
                    changes_detected.append(f"Порт: {dev1.get('switch_port', '-')} → {dev2.get('switch_port', '-')}")
                
                if changes_detected:
                    change = {
                        'mac': mac, 'mac_display': mac_display, 'oui_values': oui_values, 'type': 'modified',
                        'old_vendor': dev1.get('vendor', '-'), 'new_vendor': dev2.get('vendor', '-'),
                        'old_model': dev1.get('model', '-'), 'new_model': dev2.get('model', '-'),
                        'old_ip': dev1.get('ip', '-'), 'new_ip': dev2.get('ip', '-'),
                        'old_address': dev1.get('address', '-'), 'new_address': dev2.get('address', '-'),
                        'old_room': dev1.get('room', '-'), 'new_room': dev2.get('room', '-'),
                        'old_switch_ip': dev1.get('switch_ip', '-'), 'new_switch_ip': dev2.get('switch_ip', '-'),
                        'old_switch_port': dev1.get('switch_port', '-'), 'new_switch_port': dev2.get('switch_port', '-'),
                        'description': "\n".join(changes_detected)
                    }
                    self.all_changes.append(change)
                    self.modified_changes.append(change)
        
        added = len(self.added_changes)
        removed = len(self.removed_changes)
        modified = len(self.modified_changes)
        
        stats_text = f"Статистика сравнения\n{'-' * 50}\n"
        stats_text += f"Добавлено устройств: {added}\n"
        stats_text += f"Удалено устройств: {removed}\n"
        stats_text += f"Изменено устройств: {modified}\n"
        stats_text += f"Всего изменений: {len(self.all_changes)}\n"
        stats_text += f"{'-' * 50}\n"
        stats_text += f"Всего устройств в файле 1: {len(self.devices1)}\n"
        stats_text += f"Всего устройств в файле 2: {len(self.devices2)}"
        
        self.stats_label.setText(stats_text)
        self.switch_section("all")
        
        if len(self.all_changes) == 0:
            QMessageBox.information(self, "Сравнение завершено", "Изменений не обнаружено. Файлы идентичны.")
        else:
            QMessageBox.information(self, "Сравнение завершено", f"Сравнение завершено!\n\nДобавлено: {added}\nУдалено: {removed}\nИзменено: {modified}")
    
    def _get_type_display(self, change_type):
        types = {'added': 'Добавлено', 'removed': 'Удалено', 'modified': 'Изменено'}
        return types.get(change_type, change_type)
    
    def export_to_excel(self):
        if not self.all_changes:
            QMessageBox.warning(self, "Ошибка", "Нет данных для экспорта!")
            return
        
        filename, _ = QFileDialog.getSaveFileName(self, "Сохранить результаты сравнения",
                                                   f"comparison_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx",
                                                   "Excel Files (*.xlsx)")
        if filename:
            try:
                with pd.ExcelWriter(filename, engine='openpyxl') as writer:
                    data_all = []
                    for change in self.all_changes:
                        row = [change['mac_display'], self._get_type_display(change['type'])]
                        for length in [3, 4, 5, 6]:
                            if self.oui_formats.get(length, False):
                                row.append(change['oui_values'].get(length, '-'))
                        row.extend([
                            change['old_vendor'], change['new_vendor'],
                            change['old_model'], change['new_model'],
                            change['old_ip'], change['new_ip'],
                            change['old_address'], change['new_address'],
                            change['old_room'], change['new_room'],
                            change['old_switch_ip'], change['new_switch_ip'],
                            change['old_switch_port'], change['new_switch_port'],
                            change['description']
                        ])
                        data_all.append(row)
                    
                    headers = ["MAC-адрес", "Тип изменения"]
                    if self.oui_formats.get(3, False): headers.append("OUI (3 байта)")
                    if self.oui_formats.get(4, False): headers.append("OUI (4 байта)")
                    if self.oui_formats.get(5, False): headers.append("OUI (5 байт)")
                    if self.oui_formats.get(6, False): headers.append("OUI (6 байт)")
                    headers.extend([
                        "Производитель (было)", "Производитель (стало)",
                        "Модель (было)", "Модель (стало)",
                        "IP-адрес (было)", "IP-адрес (стало)",
                        "Адрес (было)", "Адрес (стало)",
                        "Помещение (было)", "Помещение (стало)",
                        "IP коммутатора (было)", "IP коммутатора (стало)",
                        "Порт (было)", "Порт (стало)",
                        "Описание изменений"
                    ])
                    
                    df_all = pd.DataFrame(data_all, columns=headers)
                    df_all.to_excel(writer, sheet_name='Все изменения', index=False)
                    
                    if self.added_changes:
                        data_added = []
                        for change in self.added_changes:
                            row = [
                                change['mac_display'],
                                change['new_vendor'], change['new_model'],
                                change['new_ip'], change['new_address'], change['new_room'],
                                change['new_switch_ip'], change['new_switch_port']
                            ]
                            data_added.append(row)
                        df_added = pd.DataFrame(data_added, columns=[
                            "MAC", "Производитель", "Модель", "IP", "Адрес", 
                            "Помещение", "IP коммутатора", "Порт"
                        ])
                        df_added.to_excel(writer, sheet_name='Добавленные', index=False)
                    
                    if self.removed_changes:
                        data_removed = []
                        for change in self.removed_changes:
                            row = [
                                change['mac_display'],
                                change['old_vendor'], change['old_model'],
                                change['old_ip'], change['old_address'], change['old_room'],
                                change['old_switch_ip'], change['old_switch_port']
                            ]
                            data_removed.append(row)
                        df_removed = pd.DataFrame(data_removed, columns=[
                            "MAC", "Производитель", "Модель", "IP", "Адрес", 
                            "Помещение", "IP коммутатора", "Порт"
                        ])
                        df_removed.to_excel(writer, sheet_name='Удаленные', index=False)
                    
                    if self.modified_changes:
                        data_modified = []
                        for change in self.modified_changes:
                            row = [
                                change['mac_display'],
                                change['old_vendor'], change['new_vendor'],
                                change['old_model'], change['new_model'],
                                change['old_ip'], change['new_ip'],
                                change['old_address'], change['new_address'],
                                change['old_room'], change['new_room'],
                                change['old_switch_ip'], change['new_switch_ip'],
                                change['old_switch_port'], change['new_switch_port'],
                                change['description']
                            ]
                            data_modified.append(row)
                        df_modified = pd.DataFrame(data_modified, columns=[
                            "MAC", "Производитель (было)", "Производитель (стало)",
                            "Модель (было)", "Модель (стало)",
                            "IP (было)", "IP (стало)",
                            "Адрес (было)", "Адрес (стало)",
                            "Помещение (было)", "Помещение (стало)",
                            "IP коммутатора (было)", "IP коммутатора (стало)",
                            "Порт (было)", "Порт (стало)",
                            "Описание изменений"
                        ])
                        df_modified.to_excel(writer, sheet_name='Измененные', index=False)
                    
                    stats_data = [
                        ['Показатель', 'Значение'],
                        ['Всего устройств в файле 1', len(self.devices1)],
                        ['Всего устройств в файле 2', len(self.devices2)],
                        ['Добавлено устройств', len(self.added_changes)],
                        ['Удалено устройств', len(self.removed_changes)],
                        ['Изменено устройств', len(self.modified_changes)],
                        ['Всего изменений', len(self.all_changes)]
                    ]
                    df_stats = pd.DataFrame(stats_data[1:], columns=stats_data[0])
                    df_stats.to_excel(writer, sheet_name='Статистика', index=False)
                
                QMessageBox.information(self, "Успех", f"Результаты сохранены в {filename}")
            except Exception as e:
                QMessageBox.warning(self, "Ошибка", f"Ошибка при экспорте: {str(e)}")
    
    def export_to_csv(self):
        if not self.all_changes:
            QMessageBox.warning(self, "Ошибка", "Нет данных для экспорта!")
            return
        
        filename, _ = QFileDialog.getSaveFileName(self, "Сохранить результаты сравнения",
                                                   f"comparison_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv",
                                                   "CSV Files (*.csv)")
        if filename:
            try:
                with open(filename, 'w', encoding='utf-8-sig', newline='') as f:
                    writer = csv.writer(f)
                    headers = ["MAC-адрес", "Тип изменения"]
                    if self.oui_formats.get(3, False): headers.append("OUI (3 байта)")
                    if self.oui_formats.get(4, False): headers.append("OUI (4 байта)")
                    if self.oui_formats.get(5, False): headers.append("OUI (5 байт)")
                    if self.oui_formats.get(6, False): headers.append("OUI (6 байт)")
                    headers.extend([
                        "Производитель (было)", "Производитель (стало)",
                        "Модель (было)", "Модель (стало)",
                        "IP-адрес (было)", "IP-адрес (стало)",
                        "Адрес (было)", "Адрес (стало)",
                        "Помещение (было)", "Помещение (стало)",
                        "IP коммутатора (было)", "IP коммутатора (стало)",
                        "Порт (было)", "Порт (стало)",
                        "Описание изменений"
                    ])
                    writer.writerow(headers)
                    
                    for change in self.all_changes:
                        row = [change['mac_display'], self._get_type_display(change['type'])]
                        for length in [3, 4, 5, 6]:
                            if self.oui_formats.get(length, False):
                                row.append(change['oui_values'].get(length, '-'))
                        row.extend([
                            change['old_vendor'], change['new_vendor'],
                            change['old_model'], change['new_model'],
                            change['old_ip'], change['new_ip'],
                            change['old_address'], change['new_address'],
                            change['old_room'], change['new_room'],
                            change['old_switch_ip'], change['new_switch_ip'],
                            change['old_switch_port'], change['new_switch_port'],
                            change['description']
                        ])
                        writer.writerow(row)
                
                QMessageBox.information(self, "Успех", f"Результаты сохранены в {filename}")
            except Exception as e:
                QMessageBox.warning(self, "Ошибка", f"Ошибка при экспорте: {str(e)}")
    
    def export_to_txt(self):
        if not self.all_changes:
            QMessageBox.warning(self, "Ошибка", "Нет данных для экспорта!")
            return
        
        filename, _ = QFileDialog.getSaveFileName(self, "Сохранить отчет",
                                                   f"comparison_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt",
                                                   "Text Files (*.txt)")
        if filename:
            with open(filename, 'w', encoding='utf-8-sig') as f:
                f.write("=" * 100 + "\n")
                f.write("ОТЧЕТ О СРАВНЕНИИ ФАЙЛОВ\n")
                f.write(f"Дата: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
                f.write(f"Файл 1: {self.file1_name}\n")
                f.write(f"Файл 2: {self.file2_name}\n")
                f.write("=" * 100 + "\n\n")
                f.write(self.stats_label.text() + "\n\n")
                f.write("=" * 100 + "\n\n")
                f.write("ДЕТАЛЬНЫЙ ОТЧЕТ ОБ ИЗМЕНЕНИЯХ\n")
                f.write("=" * 100 + "\n\n")
                
                for i, change in enumerate(self.all_changes, 1):
                    f.write(f"[{i}] {change['mac_display']}\n")
                    f.write(f"    Тип изменения: {self._get_type_display(change['type'])}\n")
                    f.write(f"    {change['description']}\n")
                    f.write("-" * 60 + "\n")
            
            QMessageBox.information(self, "Успех", f"Отчет сохранен в {filename}")


# ==================== ДИАЛОГ СТАТИСТИКИ ПО ВРЕМЕНИ ====================

class TimeStatsDialog(QDialog):
    def __init__(self, stats_db, parent=None):
        super().__init__(parent)
        self.stats_db = stats_db
        self.setWindowTitle("Статистика по времени")
        self.setModal(True)
        self.setGeometry(200, 200, 900, 600)
        self.setStyleSheet(parent.styleSheet() if parent else "")
        self.init_ui()
        self.load_data()
    
    def init_ui(self):
        layout = QVBoxLayout()
        title = QLabel("Динамика изменения количества устройств")
        title.setFont(QFont("Segoe UI", 14, QFont.Bold))
        layout.addWidget(title)
        self.figure = plt.figure(figsize=(10, 5))
        self.canvas = FigureCanvasQTAgg(self.figure)
        layout.addWidget(self.canvas)
        self.history_table = QTableWidget()
        self.history_table.setColumnCount(5)
        self.history_table.setHorizontalHeaderLabels(["Дата", "Время", "Файл", "Устройств", "Время обработки"])
        self.history_table.horizontalHeader().setStretchLastSection(True)
        layout.addWidget(self.history_table)
        self.setLayout(layout)
    
    def load_data(self):
        trends = self.stats_db.get_trends(30)
        self.figure.clear()
        if trends:
            dates = [t[0] for t in trends]
            totals = [t[1] for t in trends]
            new_devices = [t[2] for t in trends]
            ax = self.figure.add_subplot(111)
            ax.plot(dates, totals, marker='o', linewidth=2, markersize=8, label='Всего устройств')
            ax.bar(dates, new_devices, alpha=0.5, label='Новых устройств')
            ax.set_xlabel('Дата')
            ax.set_ylabel('Количество устройств')
            ax.set_title('Динамика изменения количества устройств за последние 30 дней')
            ax.legend()
            ax.grid(True, alpha=0.3)
            plt.setp(ax.xaxis.get_majorticklabels(), rotation=45, ha='right')
            self.figure.tight_layout()
        else:
            ax = self.figure.add_subplot(111)
            ax.text(0.5, 0.5, 'Нет данных для отображения\nВыполните хотя бы один анализ', ha='center', va='center', fontsize=14)
            ax.set_title('Динамика изменений')
        self.canvas.draw()
        history = self.stats_db.get_analysis_history(50)
        self.history_table.setRowCount(len(history))
        for i, h in enumerate(history):
            self.history_table.setItem(i, 0, QTableWidgetItem(h[0][:10]))
            self.history_table.setItem(i, 1, QTableWidgetItem(h[0][11:19]))
            self.history_table.setItem(i, 2, QTableWidgetItem(Path(h[1]).name if h[1] else '-'))
            self.history_table.setItem(i, 3, QTableWidgetItem(str(h[2])))
            processing_time = h[4] if len(h) > 4 else 0
            self.history_table.setItem(i, 4, QTableWidgetItem(f"{processing_time:.2f} сек"))
        self.history_table.resizeColumnsToContents()


# ==================== ДИАЛОГ НАСТРОЙКИ ОПОВЕЩЕНИЙ ====================

class NotificationSettingsDialog(QDialog):
    def __init__(self, notification_service, parent=None):
        super().__init__(parent)
        self.notification_service = notification_service
        self.setWindowTitle("Настройка оповещений")
        self.setModal(True)
        self.setGeometry(300, 300, 550, 550)
        self.setStyleSheet(parent.styleSheet() if parent else "")
        self.init_ui()
    
    def init_ui(self):
        layout = QVBoxLayout()
        tabs = QTabWidget()
        
        email_tab = QWidget()
        email_layout = QFormLayout(email_tab)
        self.email_enabled = QCheckBox("Включить Email оповещения")
        self.email_enabled.setChecked(self.notification_service.email_config.get('enabled', False))
        email_layout.addRow(self.email_enabled)
        self.smtp_server = QLineEdit(self.notification_service.email_config.get('smtp_server', 'smtp.gmail.com'))
        email_layout.addRow("SMTP сервер:", self.smtp_server)
        self.smtp_port = QLineEdit(str(self.notification_service.email_config.get('smtp_port', 587)))
        email_layout.addRow("Порт:", self.smtp_port)
        self.from_email = QLineEdit(self.notification_service.email_config.get('from_email', ''))
        email_layout.addRow("Email отправителя:", self.from_email)
        self.email_password = QLineEdit(self.notification_service.email_config.get('password', ''))
        self.email_password.setEchoMode(QLineEdit.Password)
        email_layout.addRow("Пароль:", self.email_password)
        self.to_email = QLineEdit(self.notification_service.email_config.get('to_email', ''))
        email_layout.addRow("Email получателя:", self.to_email)
        test_email_btn = QPushButton("Тестовое письмо")
        test_email_btn.clicked.connect(self.send_test_email)
        email_layout.addRow(test_email_btn)
        tabs.addTab(email_tab, "Email")
        
        telegram_tab = QWidget()
        telegram_layout = QFormLayout(telegram_tab)
        self.telegram_token_edit = QLineEdit(self.notification_service.telegram_token or '')
        telegram_layout.addRow("Bot Token:", self.telegram_token_edit)
        self.telegram_chat_id_edit = QLineEdit(self.notification_service.telegram_chat_id or '')
        telegram_layout.addRow("Chat ID:", self.telegram_chat_id_edit)
        test_telegram_btn = QPushButton("Тестовое сообщение")
        test_telegram_btn.clicked.connect(self.send_test_telegram)
        telegram_layout.addRow(test_telegram_btn)
        tabs.addTab(telegram_tab, "Telegram")
        
        slack_tab = QWidget()
        slack_layout = QFormLayout(slack_tab)
        self.slack_webhook_edit = QLineEdit(self.notification_service.slack_webhook or '')
        slack_layout.addRow("Webhook URL:", self.slack_webhook_edit)
        test_slack_btn = QPushButton("Тестовое сообщение в Slack")
        test_slack_btn.clicked.connect(self.send_test_slack)
        slack_layout.addRow(test_slack_btn)
        tabs.addTab(slack_tab, "Slack")
        
        layout.addWidget(tabs)
        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        buttons.accepted.connect(self.save_settings)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)
        self.setLayout(layout)
    
    def send_test_email(self):
        if self.email_enabled.isChecked() and self.from_email.text() and self.email_password.text():
            success = self.notification_service.send_email("Тестовое сообщение", "<h3>Тест</h3><p>Тестовое сообщение от MAC Analyzer Pro!</p>", self.to_email.text())
            if success:
                QMessageBox.information(self, "Успех", "Тестовое письмо отправлено!")
            else:
                QMessageBox.warning(self, "Ошибка", "Не удалось отправить письмо.")
    
    def send_test_telegram(self):
        token = self.telegram_token_edit.text()
        chat_id = self.telegram_chat_id_edit.text()
        if token and chat_id and REQUESTS_AVAILABLE:
            url = f"https://api.telegram.org/bot{token}/sendMessage"
            try:
                response = requests.post(url, json={'chat_id': chat_id, 'text': "Тестовое сообщение от MAC Analyzer Pro!"}, timeout=10)
                if response.status_code == 200:
                    QMessageBox.information(self, "Успех", "Тестовое сообщение отправлено!")
                else:
                    QMessageBox.warning(self, "Ошибка", f"Ошибка: {response.text}")
            except Exception as e:
                QMessageBox.warning(self, "Ошибка", str(e))
    
    def send_test_slack(self):
        webhook = self.slack_webhook_edit.text()
        if webhook and REQUESTS_AVAILABLE:
            try:
                response = requests.post(webhook, json={'text': "Тестовое сообщение от MAC Analyzer Pro!"}, timeout=10)
                if response.status_code == 200:
                    QMessageBox.information(self, "Успех", "Тестовое сообщение отправлено в Slack!")
                else:
                    QMessageBox.warning(self, "Ошибка", f"Ошибка: {response.text}")
            except Exception as e:
                QMessageBox.warning(self, "Ошибка", str(e))
    
    def save_settings(self):
        self.notification_service.email_config = {
            'enabled': self.email_enabled.isChecked(),
            'smtp_server': self.smtp_server.text(),
            'smtp_port': int(self.smtp_port.text()) if self.smtp_port.text().isdigit() else 587,
            'from_email': self.from_email.text(),
            'password': self.email_password.text(),
            'to_email': self.to_email.text()
        }
        self.notification_service.telegram_token = self.telegram_token_edit.text()
        self.notification_service.telegram_chat_id = self.telegram_chat_id_edit.text()
        self.notification_service.slack_webhook = self.slack_webhook_edit.text()
        self.notification_service.save_config()
        self.accept()


# ==================== ДИАЛОГ ПЛАНИРОВЩИКА ====================

class SchedulerDialog(QDialog):
    def __init__(self, scheduler, parent=None):
        super().__init__(parent)
        self.scheduler = scheduler
        self.setWindowTitle("Планировщик задач")
        self.setModal(True)
        self.setGeometry(300, 300, 500, 450)
        self.setStyleSheet(parent.styleSheet() if parent else "")
        self.init_ui()
    
    def init_ui(self):
        layout = QVBoxLayout()
        time_group = QGroupBox("Время выполнения")
        time_layout = QVBoxLayout()
        time_h_layout = QHBoxLayout()
        time_h_layout.addWidget(QLabel("Час:"))
        self.hour_spin = QSpinBox()
        self.hour_spin.setRange(0, 23)
        self.hour_spin.setValue(9)
        time_h_layout.addWidget(self.hour_spin)
        time_h_layout.addWidget(QLabel("Минута:"))
        self.minute_spin = QSpinBox()
        self.minute_spin.setRange(0, 59)
        self.minute_spin.setValue(0)
        time_h_layout.addWidget(self.minute_spin)
        time_h_layout.addStretch()
        time_layout.addLayout(time_h_layout)
        self.time_label = QLabel("Запланированное время: 09:00")
        time_layout.addWidget(self.time_label)
        self.hour_spin.valueChanged.connect(self.update_time_label)
        self.minute_spin.valueChanged.connect(self.update_time_label)
        time_group.setLayout(time_layout)
        layout.addWidget(time_group)
        
        files_group = QGroupBox("Файлы для анализа")
        files_layout = QVBoxLayout()
        self.files_list = QListWidget()
        self.files_list.setMaximumHeight(150)
        files_layout.addWidget(self.files_list)
        file_buttons = QHBoxLayout()
        add_file_btn = QPushButton("Добавить файл")
        add_file_btn.clicked.connect(self.add_file)
        remove_file_btn = QPushButton("Удалить выбранный")
        remove_file_btn.clicked.connect(self.remove_file)
        clear_btn = QPushButton("Очистить список")
        clear_btn.clicked.connect(self.files_list.clear)
        file_buttons.addWidget(add_file_btn)
        file_buttons.addWidget(remove_file_btn)
        file_buttons.addWidget(clear_btn)
        files_layout.addLayout(file_buttons)
        files_group.setLayout(files_layout)
        layout.addWidget(files_group)
        
        self.repeat_check = QCheckBox("Повторять ежедневно")
        self.repeat_check.setChecked(True)
        layout.addWidget(self.repeat_check)
        info_label = QLabel("При повторении анализ будет запускаться каждый день в указанное время.")
        info_label.setWordWrap(True)
        layout.addWidget(info_label)
        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        buttons.accepted.connect(self.schedule)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)
        self.setLayout(layout)
    
    def update_time_label(self):
        self.time_label.setText(f"Запланированное время: {self.hour_spin.value():02d}:{self.minute_spin.value():02d}")
    
    def add_file(self):
        f, _ = QFileDialog.getOpenFileName(self, "Выберите файл", "", "Excel Files (*.xlsx *.xls *.csv)")
        if f:
            self.files_list.addItem(f)
    
    def remove_file(self):
        current_row = self.files_list.currentRow()
        if current_row >= 0:
            self.files_list.takeItem(current_row)
    
    def schedule(self):
        files = [self.files_list.item(i).text() for i in range(self.files_list.count())]
        if files:
            result = self.scheduler.schedule_daily_analysis(self.hour_spin.value(), self.minute_spin.value(), files)
            QMessageBox.information(self, "Планировщик", result)
            self.accept()
        else:
            QMessageBox.warning(self, "Ошибка", "Добавьте хотя бы один файл!")


# ==================== ПОТОК ОБОГАЩЕНИЯ С ОТМЕНОЙ ====================

class EnrichmentWorker(CancellableWorker):
    progress = pyqtSignal(int)
    status = pyqtSignal(str)
    finished = pyqtSignal(object)
    error = pyqtSignal(str)
    file_progress = pyqtSignal(int, int)
    
    def __init__(self, enricher, analyzer, sheet, row_strategy):
        super().__init__()
        self.enricher = enricher
        self.analyzer = analyzer
        self.sheet = sheet
        self.row_strategy = row_strategy
    
    def run(self):
        try:
            total_files = len(self.enricher.files)
            processed = 0
            
            if self.enricher.primary_alias:
                if self.is_cancelled():
                    self.error.emit("Операция отменена пользователем")
                    return
                
                self.status.emit(f"Загрузка основного файла {self.enricher.primary_alias}...")
                self.progress.emit(10)
                
                def load_progress(current, total):
                    if total > 0:
                        percent = int(20 + (current / total) * 30)
                        self.progress.emit(percent)
                    QApplication.processEvents()
                
                success = self.enricher.load_file(self.enricher.primary_alias, self.analyzer, self.sheet, load_progress)
                if not success:
                    self.error.emit(f"Ошибка загрузки основного файла")
                    return
                self.progress.emit(30)
            
            for alias, info in self.enricher.files.items():
                if info['is_primary']:
                    continue
                    
                if self.is_cancelled():
                    self.error.emit("Операция отменена пользователем")
                    return
                
                self.status.emit(f"Загрузка {alias}...")
                
                def add_progress(current, total):
                    if total > 0:
                        percent = int(30 + (current / total) * 30)
                        self.progress.emit(percent)
                    QApplication.processEvents()
                
                success = self.enricher.load_file(alias, self.analyzer, self.sheet, add_progress)
                if not success:
                    self.error.emit(f"Ошибка загрузки файла {alias}")
                    return
                processed += 1
                progress_value = int(30 + (processed / total_files) * 40) if total_files > 0 else 60
                self.progress.emit(progress_value)
            
            if self.is_cancelled():
                self.error.emit("Операция отменена пользователем")
                return
            
            self.status.emit("Обогащение данных...")
            self.progress.emit(70)
            QApplication.processEvents()
            
            self.enricher.set_row_strategy(self.row_strategy)
            result = self.enricher.enrich()
            
            self.progress.emit(100)
            self.finished.emit(result)
            
        except Exception as e:
            self.error.emit(str(e))


# ==================== ДИАЛОГ ВЫБОРА ТЕМЫ ====================

class ThemeSelectionDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.parent = parent
        self.setWindowTitle("Выбор темы оформления")
        self.setModal(True)
        self.setGeometry(300, 300, 450, 500)
        self.setStyleSheet(parent.styleSheet() if parent else "")
        self.init_ui()
    
    def init_ui(self):
        layout = QVBoxLayout()
        title = QLabel("Выбор темы оформления")
        title.setFont(QFont("Segoe UI", 14, QFont.Bold))
        layout.addWidget(title)
        
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll_widget = QWidget()
        scroll_layout = QVBoxLayout(scroll_widget)
        
        for theme_key, theme_info in THEMES.items():
            btn = QPushButton(theme_info['name'])
            btn.clicked.connect(lambda checked, k=theme_key: self.parent.apply_theme(k))
            scroll_layout.addWidget(btn)
        
        scroll_layout.addStretch()
        scroll.setWidget(scroll_widget)
        layout.addWidget(scroll)
        
        button_box = QDialogButtonBox(QDialogButtonBox.Close)
        button_box.rejected.connect(self.accept)
        layout.addWidget(button_box)
        self.setLayout(layout)


# ==================== AI-АССИСТЕНТ ====================

class AIAssistant:
    def analyze_data_quality(self, devices):
        issues = []
        recommendations = []
        if not devices:
            return issues, recommendations
        total = len(devices)
        mac_counts = Counter([d['mac'] for d in devices if d.get('mac')])
        duplicates = {mac: count for mac, count in mac_counts.items() if count > 1}
        if duplicates:
            issues.append(f"Найдено {len(duplicates)} дублирующихся MAC-адресов")
            recommendations.append("Рекомендуется объединить дублирующиеся записи")
        for field, label in [('vendor', 'Производитель'), ('model', 'Модель'),
                              ('address', 'Адрес'), ('ip', 'IP'), ('room', 'Помещение'),
                              ('switch_ip', 'IP коммутатора'), ('switch_port', 'Порт')]:
            filled = len([d for d in devices if d.get(field) and d[field] not in ['Unknown', 'Не указано', None, '']])
            percent = filled / total * 100 if total > 0 else 0
            if percent < 50:
                issues.append(f"Поле '{label}' заполнено только на {percent:.1f}%")
                if field == 'vendor':
                    recommendations.append("Будет выполнено автоматическое определение производителя по OUI (3 байта MAC) и ИСТОРИИ")
                elif field == 'model':
                    recommendations.append("Будет выполнено автоматическое определение модели по префиксу MAC (5 байт) и ИСТОРИИ")
                elif field == 'address':
                    recommendations.append("Рекомендуется настроить соответствие IP → адрес для автоматического заполнения")
                else:
                    recommendations.append(f"Рекомендуется добавить файл с данными о {label.lower()}")
        return issues, recommendations


# ==================== ДИАЛОГ API НАСТРОЕК ====================

class APISettingsDialog(QDialog):
    def __init__(self, api_client, parent=None):
        super().__init__(parent)
        self.api_client = api_client
        self.setWindowTitle("Настройка API")
        self.setModal(True)
        self.setGeometry(350, 350, 500, 400)
        self.setStyleSheet(parent.styleSheet() if parent else "")
        self.init_ui()
    
    def init_ui(self):
        layout = QVBoxLayout()
        title = QLabel("Настройка API")
        title.setFont(QFont("Segoe UI", 14, QFont.Bold))
        layout.addWidget(title)
        info_label = QLabel("API позволяет получать информацию о производителях MAC-адресов из внешних источников.")
        info_label.setWordWrap(True)
        layout.addWidget(info_label)
        
        group = QGroupBox("Выбор API сервиса")
        group_layout = QVBoxLayout()
        self.service_combo = QComboBox()
        for service in self.api_client.get_service_list():
            desc = MACVendorAPI.API_SERVICES[service]['description']
            self.service_combo.addItem(f"{service} - {desc}", service)
        current_index = self.service_combo.findData(self.api_client.service)
        if current_index >= 0:
            self.service_combo.setCurrentIndex(current_index)
        group_layout.addWidget(QLabel("API сервис:"))
        group_layout.addWidget(self.service_combo)
        group.setLayout(group_layout)
        layout.addWidget(group)
        
        test_group = QGroupBox("Тестирование API")
        test_layout = QVBoxLayout()
        test_mac_edit = QLineEdit()
        test_mac_edit.setPlaceholderText("Введите MAC-адрес для теста (например: 00:1A:11:22:33:44)")
        test_layout.addWidget(test_mac_edit)
        test_btn = QPushButton("Тестовый запрос")
        test_btn.clicked.connect(lambda: self.test_api(test_mac_edit.text()))
        test_layout.addWidget(test_btn)
        self.test_result = QLabel("")
        test_layout.addWidget(self.test_result)
        test_group.setLayout(test_layout)
        layout.addWidget(test_group)
        
        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        buttons.accepted.connect(self.save_settings)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)
        self.setLayout(layout)
    
    def test_api(self, mac):
        if not mac:
            QMessageBox.warning(self, "Ошибка", "Введите MAC-адрес для теста!")
            return
        self.test_result.setText("Выполняется запрос...")
        QApplication.processEvents()
        vendor = self.api_client.get_vendor_by_mac(mac)
        if vendor:
            self.test_result.setText(f"Найден производитель: {vendor}")
        else:
            self.test_result.setText("Производитель не найден или API недоступен")
    
    def save_settings(self):
        self.api_client.set_service(self.service_combo.currentData())
        self.accept()


# ==================== ДИАЛОГ API ОБОГАЩЕНИЯ ====================

class APIEnrichmentDialog(QDialog):
    def __init__(self, api_client, parent=None):
        super().__init__(parent)
        self.api_client = api_client
        self.parent_window = parent
        self.setWindowTitle("Обогащение через API")
        self.setModal(True)
        self.setGeometry(350, 350, 600, 500)
        self.devices_to_process = []
        self.init_ui()
        self.load_devices()
    
    def init_ui(self):
        layout = QVBoxLayout()
        title = QLabel("Обогащение данных через API")
        title.setFont(QFont("Segoe UI", 14, QFont.Bold))
        layout.addWidget(title)
        info_label = QLabel("API позволяет получить дополнительную информацию о производителях MAC-адресов из внешних источников.\n"
                           "⚠️ Данные из файла имеют приоритет и не будут перезаписаны.")
        info_label.setWordWrap(True)
        layout.addWidget(info_label)
        
        field_group = QGroupBox("Параметры обогащения")
        field_layout = QFormLayout()
        self.enrich_vendor_cb = QCheckBox("Обогатить производителя (через API)")
        self.enrich_vendor_cb.setChecked(True)
        field_layout.addRow(self.enrich_vendor_cb)
        self.only_unknown_cb = QCheckBox("Только для неизвестных производителей")
        self.only_unknown_cb.setChecked(True)
        field_layout.addRow(self.only_unknown_cb)
        field_group.setLayout(field_layout)
        layout.addWidget(field_group)
        
        devices_group = QGroupBox("Устройства для обогащения")
        devices_layout = QVBoxLayout()
        self.devices_list = QListWidget()
        self.devices_list.setSelectionMode(QListWidget.MultiSelection)
        devices_layout.addWidget(self.devices_list)
        select_all_btn = QPushButton("Выбрать все")
        select_all_btn.clicked.connect(lambda: self.devices_list.selectAll())
        deselect_all_btn = QPushButton("Снять все")
        deselect_all_btn.clicked.connect(lambda: self.devices_list.clearSelection())
        select_layout = QHBoxLayout()
        select_layout.addWidget(select_all_btn)
        select_layout.addWidget(deselect_all_btn)
        devices_layout.addLayout(select_layout)
        devices_group.setLayout(devices_layout)
        layout.addWidget(devices_group)
        
        self.progress_bar = QProgressBar()
        self.progress_bar.setVisible(False)
        layout.addWidget(self.progress_bar)
        self.status_label = QLabel("")
        layout.addWidget(self.status_label)
        
        btn_layout = QHBoxLayout()
        self.start_btn = QPushButton("Запустить обогащение через API")
        self.start_btn.clicked.connect(self.start_enrichment)
        btn_layout.addWidget(self.start_btn)
        cancel_btn = QPushButton("Отмена")
        cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(cancel_btn)
        layout.addLayout(btn_layout)
        
        self.setLayout(layout)
    
    def load_devices(self):
        if self.parent_window and hasattr(self.parent_window, 'current_devices') and self.parent_window.current_devices:
            for dev in self.parent_window.current_devices:
                mac = dev.get('mac_formatted', dev.get('mac', ''))
                vendor = dev.get('vendor', 'Unknown')
                item = QListWidgetItem(f"{mac} - Производитель: {vendor}")
                item.setData(Qt.UserRole, dev)
                self.devices_list.addItem(item)
                self.devices_to_process.append(dev)
    
    def start_enrichment(self):
        selected_items = self.devices_list.selectedItems()
        if not selected_items:
            QMessageBox.warning(self, "Ошибка", "Выберите устройства для обогащения!")
            return
        devices_to_enrich = []
        for item in selected_items:
            dev = item.data(Qt.UserRole)
            if self.only_unknown_cb.isChecked() and dev.get('vendor', 'Unknown') != 'Unknown':
                continue
            # Не обогащаем, если производитель уже есть из файла
            if dev.get('vendor_source') == 'Из файла':
                continue
            devices_to_enrich.append(dev)
        if not devices_to_enrich:
            QMessageBox.information(self, "Информация", "Нет устройств для обогащения")
            return
        
        self.thread = QThread()
        self.worker = APIEnrichmentWorker(self.api_client, devices_to_enrich, self.enrich_vendor_cb.isChecked())
        self.worker.moveToThread(self.thread)
        self.thread.started.connect(self.worker.run)
        self.worker.progress.connect(self.update_progress)
        self.worker.status.connect(self.update_status)
        self.worker.finished.connect(self.on_enrichment_finished)
        self.worker.finished.connect(self.thread.quit)
        self.worker.finished.connect(self.worker.deleteLater)
        self.thread.finished.connect(self.thread.deleteLater)
        self.start_btn.setEnabled(False)
        self.progress_bar.setVisible(True)
        self.progress_bar.setMaximum(len(devices_to_enrich))
        self.thread.start()
    
    def update_progress(self, value, total):
        self.progress_bar.setValue(value)
        self.progress_bar.setMaximum(total)
    
    def update_status(self, message):
        self.status_label.setText(message)
    
    def on_enrichment_finished(self, updated_devices):
        self.progress_bar.setVisible(False)
        self.start_btn.setEnabled(True)
        if self.parent_window and updated_devices:
            for updated in updated_devices:
                for i, dev in enumerate(self.parent_window.current_devices):
                    if dev.get('mac') == updated.get('mac'):
                        # Обновляем только если нет данных из файла
                        if dev.get('vendor_source') != 'Из файла':
                            self.parent_window.current_devices[i] = updated
                        break
            self.parent_window.display_results(self.parent_window.current_devices)
            QMessageBox.information(self, "Готово", f"Обновлено устройств: {len(updated_devices)}")
        self.accept()


# ==================== API ОБОГАЩЕНИЕ ВОРКЕР ====================

class APIEnrichmentWorker(QObject):
    progress = pyqtSignal(int, int)
    status = pyqtSignal(str)
    finished = pyqtSignal(list)
    
    def __init__(self, api_client, devices, enrich_vendor):
        super().__init__()
        self.api_client = api_client
        self.devices = devices
        self.enrich_vendor = enrich_vendor
    
    def run(self):
        updated_devices = []
        total = len(self.devices)
        for i, dev in enumerate(self.devices):
            self.status.emit(f"Обработка {dev.get('mac_formatted', dev.get('mac', ''))}")
            if self.enrich_vendor:
                mac = dev.get('mac', '')
                vendor = self.api_client.get_vendor_by_mac(mac)
                if vendor and (dev.get('vendor', 'Unknown') == 'Unknown' or vendor != dev.get('vendor')):
                    dev['vendor'] = vendor
                    dev['vendor_source'] = 'API'
                    dev['vendor_confidence'] = 0.8
                    dev['match_details'] = dev.get('match_details', '') + f"; API обогащение: {vendor}"
                    updated_devices.append(dev)
            self.progress.emit(i + 1, total)
            QApplication.processEvents()
            time.sleep(0.05)
        self.finished.emit(updated_devices)


# ==================== АНАЛИТИЧЕСКИЕ ГРАФИКИ ====================

class AnalyticsChart(QWidget):
    def __init__(self, devices=None, parent=None):
        super().__init__(parent)
        self.figure = None
        self.canvas = None
        self.init_ui()
        if devices:
            self.update_charts(devices)
    
    def init_ui(self):
        layout = QVBoxLayout()
        self.figure = plt.figure(figsize=(12, 8))
        self.canvas = FigureCanvasQTAgg(self.figure)
        layout.addWidget(self.canvas)
        self.setLayout(layout)
    
    def cleanup(self):
        if self.figure:
            plt.close(self.figure)
            self.figure = None
    
    def closeEvent(self, event):
        self.cleanup()
        super().closeEvent(event)
    
    def update_charts(self, devices):
        if not self.figure:
            self.init_ui()
        self.figure.clear()
        total = len(devices)
        
        ax1 = self.figure.add_subplot(2, 2, 1)
        vendors = [d.get('vendor', 'Unknown') for d in devices if d.get('vendor') and d['vendor'] != 'Unknown']
        if vendors and total > 0:
            vendor_counts = Counter(vendors).most_common(10)
            names, counts = zip(*vendor_counts)
            ax1.pie(counts, labels=names, autopct='%1.1f%%')
            ax1.set_title('Топ-10 производителей')
        else:
            ax1.text(0.5, 0.5, 'Нет данных', ha='center', va='center')
            ax1.set_title('Топ-10 производителей')
        
        ax2 = self.figure.add_subplot(2, 2, 2)
        rooms = [d.get('room', 'Не указано') for d in devices if d.get('room') and d['room'] not in ['Unknown', 'Не указано', None]]
        if rooms and total > 0:
            room_counts = Counter(rooms).most_common(10)
            names, counts = zip(*room_counts)
            ax2.bar(names, counts)
            ax2.set_title('Распределение по помещениям')
            plt.setp(ax2.xaxis.get_majorticklabels(), rotation=45, ha='right')
        else:
            ax2.text(0.5, 0.5, 'Нет данных', ha='center', va='center')
            ax2.set_title('Распределение по помещениям')
        
        ax3 = self.figure.add_subplot(2, 2, 3)
        fields = ['Производитель', 'Модель', 'Адрес', 'IP', 'Помещение', 'IP коммутатора', 'Порт']
        filled = [
            len([d for d in devices if d.get('vendor') and d['vendor'] != 'Unknown']),
            len([d for d in devices if d.get('model') and d['model'] not in ['Unknown', None, '']]),
            len([d for d in devices if d.get('address') and d['address'] not in ['Unknown', None, '']]),
            len([d for d in devices if d.get('ip') and d['ip'] not in ['Unknown', None, '']]),
            len([d for d in devices if d.get('room') and d['room'] not in ['Unknown', 'Не указано', None, '']]),
            len([d for d in devices if d.get('switch_ip') and d['switch_ip'] not in ['Unknown', None, '']]),
            len([d for d in devices if d.get('switch_port') and d['switch_port'] not in ['Unknown', None, '']])
        ]
        percentages = [f / total * 100 if total > 0 else 0 for f in filled]
        colors = ['#3498db', '#2ecc71', '#f39c12', '#e74c3c', '#9b59b6', '#1abc9c', '#e67e22']
        bars = ax3.bar(fields, percentages, color=colors)
        ax3.set_ylabel('Заполненность (%)')
        ax3.set_title('Заполненность полей')
        ax3.set_ylim(0, 100)
        for bar, val in zip(bars, percentages):
            ax3.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 1, f'{val:.1f}%', ha='center', va='bottom')
        
        ax4 = self.figure.add_subplot(2, 2, 4)
        if vendors and total > 0:
            vendor_counts = Counter(vendors).most_common(8)
            names, counts = zip(*vendor_counts)
            ax4.pie(counts, labels=names, autopct='%1.1f%%')
            ax4.set_title('Доля производителей')
        else:
            ax4.text(0.5, 0.5, 'Нет данных', ha='center', va='center')
            ax4.set_title('Доля производителей')
        
        self.figure.tight_layout()
        self.canvas.draw()


# ==================== ВИЗУАЛИЗАЦИЯ ТОПОЛОГИИ ====================

class NetworkTopologyWidget(QWidget):
    def __init__(self, devices=None, parent=None):
        super().__init__(parent)
        self.figure = None
        self.canvas = None
        self.init_ui()
        if devices:
            self.update_topology(devices)
    
    def init_ui(self):
        layout = QVBoxLayout()
        self.figure = plt.figure(figsize=(12, 8))
        self.canvas = FigureCanvasQTAgg(self.figure)
        layout.addWidget(self.canvas)
        self.setLayout(layout)
    
    def cleanup(self):
        if self.figure:
            plt.close(self.figure)
            self.figure = None
    
    def closeEvent(self, event):
        self.cleanup()
        super().closeEvent(event)
    
    def update_topology(self, devices):
        if not NETWORKX_AVAILABLE:
            if not self.figure:
                self.init_ui()
            self.figure.clear()
            ax = self.figure.add_subplot(111)
            ax.text(0.5, 0.5, "Установите networkx: pip install networkx", ha='center', va='center', fontsize=14)
            self.canvas.draw()
            return
        if not self.figure:
            self.init_ui()
        self.figure.clear()
        
        G = nx.Graph()
        
        for dev in devices:
            mac = dev.get('mac_formatted', '')
            if mac:
                G.add_node(mac, vendor=dev.get('vendor', 'Unknown'), room=dev.get('room', ''), 
                          switch_ip=dev.get('switch_ip', ''), switch_port=dev.get('switch_port', ''))
        
        rooms = defaultdict(list)
        switches = defaultdict(list)
        
        for dev in devices:
            room = dev.get('room')
            if room and room not in ['Unknown', 'Не указано', None]:
                mac = dev.get('mac_formatted', '')
                if mac:
                    rooms[room].append(mac)
            
            switch_ip = dev.get('switch_ip')
            if switch_ip and switch_ip not in ['Unknown', None, '']:
                mac = dev.get('mac_formatted', '')
                if mac:
                    switches[switch_ip].append(mac)
        
        for room, devices_in_room in rooms.items():
            for i in range(len(devices_in_room)):
                for j in range(i+1, len(devices_in_room)):
                    G.add_edge(devices_in_room[i], devices_in_room[j], type='room', room=room)
        
        for switch_ip, devices_on_switch in switches.items():
            switch_node = f"Switch {switch_ip}"
            G.add_node(switch_node, type='switch', ip=switch_ip)
            for dev in devices_on_switch:
                G.add_edge(dev, switch_node, type='switch', port=dev.get('switch_port', 'unknown'))
        
        ax = self.figure.add_subplot(111)
        if len(G.nodes) > 0:
            pos = nx.spring_layout(G, k=1.5, iterations=50)
            switch_nodes = [n for n in G.nodes if G.nodes[n].get('type') == 'switch']
            device_nodes = [n for n in G.nodes if G.nodes[n].get('type') != 'switch']
            
            nx.draw_networkx_nodes(G, pos, nodelist=device_nodes, node_size=500, node_color='lightblue', ax=ax)
            nx.draw_networkx_nodes(G, pos, nodelist=switch_nodes, node_size=800, node_color='lightgreen', ax=ax)
            nx.draw_networkx_edges(G, pos, width=1, alpha=0.5, ax=ax)
            nx.draw_networkx_labels(G, pos, font_size=8, ax=ax)
            
            ax.set_title(f'Топология сети ({len(G.nodes)} устройств, {len(G.edges)} связей)')
        else:
            ax.text(0.5, 0.5, "Нет данных для построения топологии", ha='center', va='center')
        
        self.figure.tight_layout()
        self.canvas.draw()


# ==================== ДИАЛОГ КЛАСТЕРИЗАЦИИ ====================

class ClusteringDialog(QDialog):
    def __init__(self, devices, parent=None):
        super().__init__(parent)
        self.devices = devices
        self.setWindowTitle("Кластеризация устройств")
        self.setModal(True)
        self.setGeometry(300, 300, 600, 500)
        self.setStyleSheet(parent.styleSheet() if parent else "")
        self.init_ui()
        self.run_clustering()
    
    def init_ui(self):
        layout = QVBoxLayout()
        title = QLabel("Кластеризация устройств")
        title.setFont(QFont("Segoe UI", 14, QFont.Bold))
        layout.addWidget(title)
        
        self.text_edit = QTextEdit()
        self.text_edit.setReadOnly(True)
        layout.addWidget(self.text_edit)
        
        button_box = QDialogButtonBox(QDialogButtonBox.Close)
        button_box.rejected.connect(self.accept)
        layout.addWidget(button_box)
        
        self.setLayout(layout)
    
    def run_clustering(self):
        if not SKLEARN_AVAILABLE:
            self.text_edit.setText("Установите scikit-learn: pip install scikit-learn")
            return
        
        if len(self.devices) < 3:
            self.text_edit.setText("Недостаточно данных для кластеризации (минимум 3 устройства)")
            return
        
        features = []
        valid_devices = []
        
        for dev in self.devices:
            try:
                mac_len = len(dev.get('mac', '')) if dev.get('mac') else 0
                vendor_len = len(dev.get('vendor', '')) if dev.get('vendor') else 0
                model_len = len(dev.get('model', '')) if dev.get('model') else 0
                address_len = len(dev.get('address', '')) if dev.get('address') else 0
                has_ip = 1 if dev.get('ip') and dev['ip'] not in ['Unknown', None, ''] else 0
                has_room = 1 if dev.get('room') and dev['room'] not in ['Unknown', 'Не указано', None, ''] else 0
                has_switch_ip = 1 if dev.get('switch_ip') and dev['switch_ip'] not in ['Unknown', None, ''] else 0
                has_switch_port = 1 if dev.get('switch_port') and dev['switch_port'] not in ['Unknown', None, ''] else 0
                
                features.append([mac_len, vendor_len, model_len, address_len, has_ip, has_room, has_switch_ip, has_switch_port])
                valid_devices.append(dev)
            except:
                continue
        
        if len(features) < 3:
            self.text_edit.setText("Недостаточно валидных данных для кластеризации")
            return
        
        try:
            scaler = StandardScaler()
            features_scaled = scaler.fit_transform(features)
            
            n_clusters = min(3, len(valid_devices))
            kmeans = KMeans(n_clusters=n_clusters, random_state=42, n_init=10)
            clusters = kmeans.fit_predict(features_scaled)
            
            cluster_stats = defaultdict(lambda: {'count': 0, 'vendors': set(), 'rooms': set(), 'switches': set()})
            for dev, cluster in zip(valid_devices, clusters):
                cluster_stats[cluster]['count'] += 1
                vendor = dev.get('vendor', 'Unknown')
                if vendor and vendor not in ['Unknown', None]:
                    cluster_stats[cluster]['vendors'].add(vendor)
                room = dev.get('room', 'Не указано')
                if room and room not in ['Unknown', 'Не указано', None]:
                    cluster_stats[cluster]['rooms'].add(room)
                switch_ip = dev.get('switch_ip', '')
                if switch_ip and switch_ip not in ['Unknown', None, '']:
                    cluster_stats[cluster]['switches'].add(switch_ip)
            
            msg = "Результаты кластеризации устройств\n\n"
            for cluster, data in cluster_stats.items():
                msg += f"Кластер {cluster + 1}:\n"
                msg += f"  • Устройств: {data['count']}\n"
                if data['vendors']:
                    vendors_list = list(data['vendors'])[:3]
                    msg += f"  • Производителей: {', '.join(vendors_list)}\n"
                if data['rooms']:
                    rooms_list = list(data['rooms'])[:3]
                    msg += f"  • Помещений: {', '.join(rooms_list)}\n"
                if data['switches']:
                    switches_list = list(data['switches'])[:3]
                    msg += f"  • Коммутаторов: {', '.join(switches_list)}\n"
                msg += "\n"
            
            self.text_edit.setText(msg)
        except Exception as e:
            self.text_edit.setText(f"Ошибка при кластеризации: {str(e)}")


# ==================== ДИАЛОГ АНАЛИЗА ОДНОГО ФАЙЛА ====================

class SingleFileAnalysisDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.parent = parent
        self.setWindowTitle("Анализ отдельного файла")
        self.setModal(True)
        self.setGeometry(300, 300, 650, 600)
        self.setStyleSheet(parent.styleSheet() if parent else "")
        self.init_ui()
    
    def init_ui(self):
        layout = QVBoxLayout()
        title = QLabel("Анализ отдельного файла")
        title.setFont(QFont("Segoe UI", 14, QFont.Bold))
        layout.addWidget(title)
        info_label = QLabel("Выберите файл для анализа. Программа выполнит полный анализ MAC-адресов.")
        info_label.setWordWrap(True)
        layout.addWidget(info_label)
        
        file_group = QGroupBox("Выбор файла")
        file_layout = QHBoxLayout()
        self.file_edit = QLineEdit()
        self.file_edit.setPlaceholderText("Выберите Excel или CSV файл...")
        browse_btn = QPushButton("Обзор")
        browse_btn.clicked.connect(self.browse_file)
        file_layout.addWidget(self.file_edit)
        file_layout.addWidget(browse_btn)
        file_group.setLayout(file_layout)
        layout.addWidget(file_group)
        
        sheet_group = QGroupBox("Параметры листа")
        sheet_layout = QHBoxLayout()
        self.sheet_combo = QComboBox()
        self.sheet_combo.addItems(["Первый лист", "Второй лист", "Третий лист"])
        sheet_layout.addWidget(QLabel("Лист:"))
        sheet_layout.addWidget(self.sheet_combo)
        sheet_layout.addStretch()
        sheet_group.setLayout(sheet_layout)
        layout.addWidget(sheet_group)
        
        columns_group = QGroupBox("Настройка колонок")
        columns_layout = QVBoxLayout()
        self.use_custom_columns = QCheckBox("Использовать ручную настройку колонок")
        self.use_custom_columns.toggled.connect(self.toggle_columns)
        columns_layout.addWidget(self.use_custom_columns)
        columns_form = QFormLayout()
        col_options = ['Не указано'] + get_all_column_letters(50)
        
        self.mac_combo = QComboBox()
        self.mac_combo.addItems(col_options)
        self.mac_combo.setCurrentText('A')
        columns_form.addRow("MAC-адрес:", self.mac_combo)
        
        self.vendor_combo = QComboBox()
        self.vendor_combo.addItems(col_options)
        columns_form.addRow("Производитель:", self.vendor_combo)
        
        self.model_combo = QComboBox()
        self.model_combo.addItems(col_options)
        columns_form.addRow("Модель:", self.model_combo)
        
        self.address_combo = QComboBox()
        self.address_combo.addItems(col_options)
        columns_form.addRow("Адрес:", self.address_combo)
        
        self.ip_combo = QComboBox()
        self.ip_combo.addItems(col_options)
        columns_form.addRow("IP-адрес:", self.ip_combo)
        
        self.room_combo = QComboBox()
        self.room_combo.addItems(col_options)
        columns_form.addRow("Помещение:", self.room_combo)
        
        self.switch_ip_combo = QComboBox()
        self.switch_ip_combo.addItems(col_options)
        columns_form.addRow("IP коммутатора:", self.switch_ip_combo)
        
        self.switch_port_combo = QComboBox()
        self.switch_port_combo.addItems(col_options)
        columns_form.addRow("Порт подключения:", self.switch_port_combo)
        
        columns_group.setLayout(columns_layout)
        columns_layout.addLayout(columns_form)
        layout.addWidget(columns_group)
        
        btn_layout = QHBoxLayout()
        auto_detect_btn = QPushButton("🤖 AI-автоопределение колонок")
        auto_detect_btn.clicked.connect(self.ai_auto_detect_columns)
        btn_layout.addWidget(auto_detect_btn)
        manual_btn = QPushButton("Ручное автоопределение")
        manual_btn.clicked.connect(self.manual_auto_detect_columns)
        btn_layout.addWidget(manual_btn)
        analyze_btn = QPushButton("Запустить анализ")
        analyze_btn.clicked.connect(self.analyze)
        btn_layout.addWidget(analyze_btn)
        cancel_btn = QPushButton("Отмена")
        cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(cancel_btn)
        layout.addLayout(btn_layout)
        
        self.setLayout(layout)
        self.toggle_columns(False)
    
    def browse_file(self):
        f, _ = QFileDialog.getOpenFileName(self, "Выберите файл", "", "Excel Files (*.xlsx *.xls *.csv)")
        if f:
            self.file_edit.setText(f)
    
    def toggle_columns(self, enabled):
        self.mac_combo.setEnabled(enabled)
        self.vendor_combo.setEnabled(enabled)
        self.model_combo.setEnabled(enabled)
        self.address_combo.setEnabled(enabled)
        self.ip_combo.setEnabled(enabled)
        self.room_combo.setEnabled(enabled)
        self.switch_ip_combo.setEnabled(enabled)
        self.switch_port_combo.setEnabled(enabled)
    
    def ai_auto_detect_columns(self):
        filepath = self.file_edit.text()
        if not filepath or not os.path.exists(filepath):
            QMessageBox.warning(self, "Ошибка", "Сначала выберите файл!")
            return
        try:
            if filepath.endswith('.csv'):
                df = pd.read_csv(filepath, encoding='utf-8', nrows=100, dtype=str)
            else:
                df = pd.read_excel(filepath, header=None, dtype=str, nrows=100, engine='openpyxl')
            
            if df.empty or len(df.columns) == 0:
                QMessageBox.warning(self, "Ошибка", "Файл пуст или не содержит данных!")
                return
            
            has_headers = False
            headers = []
            data_df = df.copy()
            
            if len(df) > 0:
                first_row = df.iloc[0]
                header_candidates = [str(v).strip() if not pd.isna(v) else '' for v in first_row]
                if header_candidates:
                    is_header = True
                    for val in header_candidates[:5]:
                        if val and validate_mac(val):
                            is_header = False
                            break
                    if is_header:
                        has_headers = True
                        headers = [str(h).strip() if not pd.isna(h) else get_column_letter(i) for i, h in enumerate(first_row)]
                        data_df = df.iloc[1:].reset_index(drop=True)
            
            mapping, candidates = AIColumnDetector.detect_columns_with_ai(data_df, headers, has_headers)
            
            show_conflict_dialog = False
            for col_idx, cand in candidates.items():
                scores = cand['scores']
                top_scores = sorted(scores.values(), reverse=True)
                if len(top_scores) > 1 and top_scores[0] > 0.25 and top_scores[1] > 0.15:
                    show_conflict_dialog = True
                    break
            
            if show_conflict_dialog:
                dialog = ColumnConflictDialog(candidates, headers, has_headers, data_df, self)
                if dialog.exec_():
                    user_mapping = dialog.get_mapping()
                    for field_key, col_letter in user_mapping.items():
                        if field_key == 'mac':
                            mapping['mac_col'] = col_letter
                        elif field_key == 'vendor':
                            mapping['vendor_col'] = col_letter
                        elif field_key == 'model':
                            mapping['model_col'] = col_letter
                        elif field_key == 'address':
                            mapping['address_col'] = col_letter
                        elif field_key == 'ip':
                            mapping['ip_col'] = col_letter
                        elif field_key == 'room':
                            mapping['room_col'] = col_letter
                        elif field_key == 'switch_ip':
                            mapping['switch_ip_col'] = col_letter
                        elif field_key == 'switch_port':
                            mapping['switch_port_col'] = col_letter
            
            if mapping.get('mac_col'):
                self.mac_combo.setCurrentText(mapping['mac_col'])
            if mapping.get('vendor_col'):
                self.vendor_combo.setCurrentText(mapping['vendor_col'])
            if mapping.get('address_col'):
                self.address_combo.setCurrentText(mapping['address_col'])
            if mapping.get('ip_col'):
                self.ip_combo.setCurrentText(mapping['ip_col'])
            if mapping.get('room_col'):
                self.room_combo.setCurrentText(mapping['room_col'])
            if mapping.get('switch_ip_col'):
                self.switch_ip_combo.setCurrentText(mapping['switch_ip_col'])
            if mapping.get('switch_port_col'):
                self.switch_port_combo.setCurrentText(mapping['switch_port_col'])
            
            self.use_custom_columns.setChecked(True)
            QMessageBox.information(self, "Готово", "AI-автоопределение колонок выполнено!")
        except Exception as e:
            QMessageBox.warning(self, "Ошибка", f"Ошибка AI-автоопределения: {str(e)}")
    
    def manual_auto_detect_columns(self):
        filepath = self.file_edit.text()
        if not filepath or not os.path.exists(filepath):
            QMessageBox.warning(self, "Ошибка", "Сначала выберите файл!")
            return
        try:
            if filepath.endswith('.csv'):
                df = pd.read_csv(filepath, encoding='utf-8', nrows=20, dtype=str)
            else:
                df = pd.read_excel(filepath, header=None, dtype=str, nrows=20, engine='openpyxl')
            
            if df.empty or len(df.columns) == 0:
                QMessageBox.warning(self, "Ошибка", "Файл пуст или не содержит данных!")
                return
            
            has_headers = False
            headers = []
            if len(df) > 0:
                first_row = df.iloc[0]
                header_candidates = [str(v).strip() if not pd.isna(v) else '' for v in first_row]
                if header_candidates:
                    is_header = True
                    for val in header_candidates[:5]:
                        if val and validate_mac(val):
                            is_header = False
                            break
                    if is_header:
                        has_headers = True
                        headers = [str(h).strip() if not pd.isna(h) else get_column_letter(i) for i, h in enumerate(first_row)]
                        df = df.iloc[1:]
            
            mapping = AutoColumnDetector.auto_detect_mapping(df, headers, has_headers)
            
            if mapping['mac_col']:
                self.mac_combo.setCurrentText(mapping['mac_col'])
            if mapping['vendor_col']:
                self.vendor_combo.setCurrentText(mapping['vendor_col'])
            if mapping['address_col']:
                self.address_combo.setCurrentText(mapping['address_col'])
            if mapping['ip_col']:
                self.ip_combo.setCurrentText(mapping['ip_col'])
            if mapping['room_col']:
                self.room_combo.setCurrentText(mapping['room_col'])
            if mapping.get('switch_ip_col'):
                self.switch_ip_combo.setCurrentText(mapping['switch_ip_col'])
            if mapping.get('switch_port_col'):
                self.switch_port_combo.setCurrentText(mapping['switch_port_col'])
            
            self.use_custom_columns.setChecked(True)
            QMessageBox.information(self, "Готово", "Ручное автоопределение колонок выполнено!")
        except Exception as e:
            QMessageBox.warning(self, "Ошибка", f"Ошибка автоопределения: {str(e)}")
    
    def analyze(self):
        filepath = self.file_edit.text()
        if not filepath or not os.path.exists(filepath):
            QMessageBox.warning(self, "Ошибка", "Выберите файл для анализа!")
            return
        
        self.accept()
        
        temp_enricher = DataEnricher()
        alias = Path(filepath).stem
        temp_enricher.add_file(filepath, alias, True)
        
        if self.use_custom_columns.isChecked():
            mapping = {
                'mac_col': self.mac_combo.currentText(),
                'vendor_col': self.vendor_combo.currentText() if self.vendor_combo.currentText() != 'Не указано' else None,
                'model_col': self.model_combo.currentText() if self.model_combo.currentText() != 'Не указано' else None,
                'address_col': self.address_combo.currentText() if self.address_combo.currentText() != 'Не указано' else None,
                'ip_col': self.ip_combo.currentText() if self.ip_combo.currentText() != 'Не указано' else None,
                'room_col': self.room_combo.currentText() if self.room_combo.currentText() != 'Не указано' else None,
                'switch_ip_col': self.switch_ip_combo.currentText() if self.switch_ip_combo.currentText() != 'Не указано' else None,
                'switch_port_col': self.switch_port_combo.currentText() if self.switch_port_combo.currentText() != 'Не указано' else None,
            }
            temp_enricher.set_mapping(alias, mapping)
        
        sheet = 0 if self.sheet_combo.currentText() == "Первый лист" else 1 if self.sheet_combo.currentText() == "Второй лист" else 2
        analyzer = MACAnalyzer()
        
        def progress_callback(current, total):
            pass
        
        success = temp_enricher.load_file(alias, analyzer, sheet, progress_callback)
        devices = temp_enricher.primary_devices
        
        temp_enricher.auto_detect_ip_address_mapping()
        devices = temp_enricher.enrich_address_by_ip(devices)
        
        devices, enrich_stats = temp_enricher.enrich_devices(devices)
        
        temp_enricher.save_scan_to_history(devices, filepath)
        
        if devices:
            self.parent.current_devices = devices
            self.parent.display_results(devices)
            self.parent.display_stats(devices)
            if hasattr(self.parent, 'chart_widget') and self.parent.chart_widget:
                self.parent.chart_widget.update_charts(devices)
            if hasattr(self.parent, 'topology_widget') and self.parent.topology_widget:
                self.parent.topology_widget.update_topology(devices)
            
            if hasattr(self.parent, 'enricher'):
                for ip, addr in temp_enricher.ip_address_mapper.ip_to_address_map.items():
                    self.parent.enricher.ip_address_mapper.add_mapping(ip, addr, source="Автоопределение из файла")
            
            self.parent.status_bar.update_stats(
                len(devices),
                len([d for d in devices if d.get('address') and d['address'] not in ['Unknown', None, '']]),
                len([d for d in devices if d.get('room') and d['room'] not in ['Unknown', 'Не указано', None, '']])
            )
            
            history_stats = temp_enricher.get_history_stats()
            
            QMessageBox.information(self, "Готово", 
                f"Анализ завершен! Найдено {len(devices)} устройств.\n"
                f"Определено соответствий IP→адрес: {len(temp_enricher.ip_address_mapper.ip_to_address_map)}\n"
                f"Обогащено производителей: {enrich_stats.get('enriched_vendor', 0)}\n"
                f"Обогащено моделей: {enrich_stats.get('enriched_model', 0)}\n"
                f"  • По OUI (3 байта): {enrich_stats.get('vendor_from_oui', 0)}\n"
                f"  • По MAC5 (5 байт): {enrich_stats.get('model_from_mac5', 0)}\n"
                f"  • ИЗ ИСТОРИИ: {history_stats.get('total_oui_vendor', 0)} уникальных производителей, {history_stats.get('total_mac5_model', 0)} уникальных префиксов")
        else:
            QMessageBox.warning(self, "Ошибка", "Не удалось загрузить данные из файла!")


# ==================== ГЛАВНОЕ ОКНО ====================

class CustomStatusBar(QStatusBar):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.stats_label = QLabel()
        self.progress_bar = QProgressBar()
        self.progress_bar.setMaximumWidth(150)
        self.progress_bar.setVisible(False)
        self.addPermanentWidget(self.stats_label, 1)
        self.addPermanentWidget(self.progress_bar)
    
    def update_stats(self, devices_count, address_count, room_count, custom_count=0, switch_count=0):
        self.stats_label.setText(f"Устройств: {devices_count} | Адресов: {address_count} | Помещений: {room_count} | Коммутаторов: {switch_count} | Пользовательских полей: {custom_count}")
    
    def show_progress(self, value, maximum=100):
        self.progress_bar.setVisible(True)
        self.progress_bar.setMaximum(maximum)
        self.progress_bar.setValue(value)
    
    def hide_progress(self):
        self.progress_bar.setVisible(False)
        self.progress_bar.setValue(0)


class DropAreaListWidget(QListWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAcceptDrops(True)
        self.parent_window = parent
    
    def dragEnterEvent(self, event):
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
    
    def dropEvent(self, event):
        for url in event.mimeData().urls():
            filepath = url.toLocalFile()
            if filepath.endswith(('.xlsx', '.xls', '.csv')):
                if hasattr(self.parent_window, 'add_file_external'):
                    self.parent_window.add_file_external(filepath)


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.analyzer = MACAnalyzer()
        self.enricher = DataEnricher()
        self.current_devices = []
        self.row_strategy = "keep_primary_only"
        self.comparison_fields = {
            'compare_mac': True, 'compare_oui': True, 'compare_vendor': False,
            'compare_model': False, 'compare_ip': False, 'compare_address': False, 
            'compare_room': False, 'compare_switch_ip': False, 'compare_switch_port': False,
            'threshold': 70
        }
        self.enrich_fields = {
            'model': True, 'address': True, 'ip': True, 'vendor': True, 
            'room': True, 'switch_ip': True, 'switch_port': True
        }
        self.oui_formats = {3: True, 4: False, 5: False, 6: False}
        self.ai_assistant = AIAssistant()
        self.stats_db = StatisticsDatabase()
        self.notification_service = NotificationService(self)
        self.scheduler = TaskScheduler(self)
        self.settings_manager = SettingsManager()
        self.logger = AppLogger()
        self.chart_widget = None
        self.topology_widget = None
        self.column_manager = ColumnManager()
        self.api_client = MACVendorAPI()
        self.current_theme = "dark"
        self.worker = None
        self.memory_monitor = MemoryMonitor()
        self.auto_save_manager = AutoSaveManager(self)
        self.signal_handler = SignalHandler(self)
        self.progress_dialog = None
        
        self.engineering_mode = False
        self.current_section = "enrichment"
        
        self.nav_enrichment_btn = None
        self.nav_compare_btn = None
        self.nav_stats_btn = None
        self.nav_settings_btn = None
        
        self.stats_db.check_and_repair_db()
        
        self.init_ui()
        self.setup_shortcuts()
        self.load_settings()
        self.auto_save_manager.start()
        self.logger.log_action("Программа запущена", "Full Edition 9.0")
        
        self.apply_mode()
    
    def apply_theme(self, theme_name):
        if theme_name in THEMES:
            self.current_theme = theme_name
            self.setStyleSheet(THEMES[theme_name]['styles'])
            self.save_settings()
            self.logger.log_action("Смена темы", theme_name)
            self.update_nav_buttons_style()
    
    def update_nav_buttons_style(self):
        if not self.engineering_mode:
            return
        
        if self.nav_enrichment_btn is None:
            return
        
        active_style = """
            QPushButton {
                background-color: #4a6a8a;
                color: white;
                border: 1px solid #6a8aaa;
                padding: 8px 16px;
                border-radius: 4px;
                font-weight: bold;
                min-width: 120px;
            }
        """
        inactive_style = """
            QPushButton {
                background-color: #3c3c3c;
                color: #e0e0e0;
                border: 1px solid #555555;
                padding: 8px 16px;
                border-radius: 4px;
                font-weight: bold;
                min-width: 120px;
            }
        """
        
        if self.current_theme == 'light':
            inactive_style = """
                QPushButton {
                    background-color: #e0e0e0;
                    color: #333333;
                    border: 1px solid #cccccc;
                    padding: 8px 16px;
                    border-radius: 4px;
                    font-weight: bold;
                    min-width: 120px;
                }
            """
        
        buttons = [
            (self.nav_enrichment_btn, "enrichment"),
            (self.nav_compare_btn, "compare"),
            (self.nav_stats_btn, "stats"),
            (self.nav_settings_btn, "settings")
        ]
        
        for btn, section in buttons:
            if self.current_section == section:
                btn.setStyleSheet(active_style)
            else:
                btn.setStyleSheet(inactive_style)
    
    def init_ui(self):
        self.setWindowTitle("MAC Analyzer Pro - Full Edition 9.0 (Пользовательский режим)")
        self.setGeometry(100, 100, 1600, 950)
        self.apply_theme("dark")
        
        central = QWidget()
        self.setCentralWidget(central)
        main_layout = QVBoxLayout(central)
        main_layout.setSpacing(10)
        main_layout.setContentsMargins(10, 10, 10, 10)
        
        header_widget = QWidget()
        header_layout = QHBoxLayout(header_widget)
        header_layout.setContentsMargins(0, 0, 0, 0)
        
        self.title_label = QLabel("MAC Analyzer Pro")
        self.title_label.setFont(QFont("Segoe UI", 20, QFont.Bold))
        self.title_label.setCursor(Qt.PointingHandCursor)
        self.title_label.mousePressEvent = self.on_title_click
        header_layout.addWidget(self.title_label)
        
        version_label = QLabel("v9.0 - Два режима работы + История MAC")
        version_label.setStyleSheet("color: #4CAF50; font-size: 11px; font-weight: bold;")
        header_layout.addWidget(version_label)
        
        self.mode_label = QLabel("👤 ПОЛЬЗОВАТЕЛЬСКИЙ РЕЖИМ")
        self.mode_label.setStyleSheet("color: #ffab40; font-size: 11px; font-weight: bold; background-color: #2d2d2d; padding: 4px 8px; border-radius: 4px;")
        header_layout.addWidget(self.mode_label)
        
        header_layout.addStretch()
        
        # Кнопка экспорта результатов
        self.export_btn = QPushButton("📎 Экспорт результатов")
        self.export_btn.clicked.connect(self.export_results)
        self.export_btn.setEnabled(False)
        header_layout.addWidget(self.export_btn)
        
        # Кнопка аналитики
        self.analytics_btn = QPushButton("📊 Аналитика")
        self.analytics_btn.clicked.connect(self.show_analytics_dialog)
        self.analytics_btn.setEnabled(False)
        header_layout.addWidget(self.analytics_btn)
        
        # Кнопка истории изменений
        self.history_changes_btn = QPushButton("📅 История изменений")
        self.history_changes_btn.clicked.connect(self.show_date_range_history)
        self.history_changes_btn.setEnabled(True)
        header_layout.addWidget(self.history_changes_btn)
        
        theme_btn = QPushButton("🎨 Сменить тему")
        theme_btn.clicked.connect(self.show_theme_selector)
        header_layout.addWidget(theme_btn)
        
        self.exit_eng_btn = QPushButton("🔓 Выйти в пользовательский режим")
        self.exit_eng_btn.clicked.connect(self.exit_engineering_mode)
        self.exit_eng_btn.hide()
        header_layout.addWidget(self.exit_eng_btn)
        
        main_layout.addWidget(header_widget)
        
        self.nav_widget = QWidget()
        nav_layout = QHBoxLayout(self.nav_widget)
        nav_layout.setSpacing(10)
        
        self.nav_search_btn = QPushButton("🔍 Поиск по БД")
        self.nav_search_btn.clicked.connect(self.show_search_dialog)
        nav_layout.addWidget(self.nav_search_btn)
        
        self.nav_history_btn = QPushButton("📚 История")
        self.nav_history_btn.clicked.connect(self.show_vendor_history)
        nav_layout.addWidget(self.nav_history_btn)
        
        self.nav_enrichment_btn = QPushButton("📊 Обогащение")
        self.nav_enrichment_btn.clicked.connect(lambda: self.switch_to_section("enrichment"))
        nav_layout.addWidget(self.nav_enrichment_btn)
        
        self.nav_compare_btn = QPushButton("🔄 Сравнение")
        self.nav_compare_btn.clicked.connect(lambda: self.switch_to_section("compare"))
        nav_layout.addWidget(self.nav_compare_btn)
        
        self.nav_stats_btn = QPushButton("📈 Статистика")
        self.nav_stats_btn.clicked.connect(lambda: self.switch_to_section("stats"))
        nav_layout.addWidget(self.nav_stats_btn)
        
        self.nav_settings_btn = QPushButton("⚙️ Настройки")
        self.nav_settings_btn.clicked.connect(lambda: self.switch_to_section("settings"))
        nav_layout.addWidget(self.nav_settings_btn)
        
        self.nav_results_btn = QPushButton("📋 Результаты")
        self.nav_results_btn.clicked.connect(self.show_results)
        nav_layout.addWidget(self.nav_results_btn)
        
        nav_layout.addStretch()
        main_layout.addWidget(self.nav_widget)
        
        line = QFrame()
        line.setFrameShape(QFrame.HLine)
        line.setFrameShadow(QFrame.Sunken)
        main_layout.addWidget(line)
        
        self.stacked_widget = QStackedWidget()
        
        self.enrichment_widget = self.create_enrichment_panel()
        self.stacked_widget.addWidget(self.enrichment_widget)
        
        self.compare_widget = self.create_compare_panel()
        self.stacked_widget.addWidget(self.compare_widget)
        
        self.stats_widget = self.create_stats_panel()
        self.stacked_widget.addWidget(self.stats_widget)
        
        self.settings_widget = self.create_settings_panel()
        self.stacked_widget.addWidget(self.settings_widget)
        
        main_layout.addWidget(self.stacked_widget)
        
        self.search_panel = QGroupBox("🔍 Поиск по базе данных")
        search_layout = QVBoxLayout()
        
        search_input_layout = QHBoxLayout()
        search_input_layout.addWidget(QLabel("Поиск:"))
        self.search_line = QLineEdit()
        self.search_line.setPlaceholderText("Введите MAC-адрес, производителя, модель, IP, адрес...")
        self.search_line.textChanged.connect(self.filter_search)
        search_input_layout.addWidget(self.search_line, 1)
        search_layout.addLayout(search_input_layout)
        
        search_type_layout = QHBoxLayout()
        self.search_vendors_btn = QPushButton("🔍 Производители")
        self.search_vendors_btn.clicked.connect(lambda: self.set_search_type("vendor"))
        search_type_layout.addWidget(self.search_vendors_btn)
        self.search_models_btn = QPushButton("🔍 Модели")
        self.search_models_btn.clicked.connect(lambda: self.set_search_type("model"))
        search_type_layout.addWidget(self.search_models_btn)
        self.search_mac_btn = QPushButton("🔍 MAC-адреса")
        self.search_mac_btn.clicked.connect(lambda: self.set_search_type("mac"))
        search_type_layout.addWidget(self.search_mac_btn)
        self.search_all_btn = QPushButton("🔍 Все")
        self.search_all_btn.clicked.connect(lambda: self.set_search_type("all"))
        search_type_layout.addWidget(self.search_all_btn)
        clear_search_btn = QPushButton("🗑 Очистить")
        clear_search_btn.clicked.connect(self.clear_search)
        search_type_layout.addWidget(clear_search_btn)
        search_layout.addLayout(search_type_layout)
        
        self.search_panel.setLayout(search_layout)
        main_layout.addWidget(self.search_panel)
        
        results_panel = QGroupBox("Результаты поиска")
        results_layout = QVBoxLayout()
        
        self.results_table = QTableWidget()
        self.results_table.setAlternatingRowColors(True)
        self.results_table.setSortingEnabled(True)
        self.results_table.itemDoubleClicked.connect(self.on_item_double_click)
        results_layout.addWidget(self.results_table)
        
        results_panel.setLayout(results_layout)
        main_layout.addWidget(results_panel)
        
        self.status_bar = CustomStatusBar()
        self.setStatusBar(self.status_bar)
        self.status_bar.showMessage("Готов к работе - Пользовательский режим (поиск по БД)")
    
    def export_results(self):
        if not self.current_devices:
            QMessageBox.warning(self, "Ошибка", "Нет данных для экспорта! Сначала выполните анализ.")
            return
        
        dialog = ExportDialog(self.current_devices, self.column_manager, self)
        dialog.exec_()
    
    def show_analytics_dialog(self):
        if not self.current_devices:
            QMessageBox.warning(self, "Ошибка", "Нет данных для аналитики! Сначала выполните анализ.")
            return
        
        dialog = AnalyticsDialog(self.current_devices, self)
        dialog.exec_()
    
    def show_date_range_history(self):
        """Показать историю изменений за период"""
        dialog = DateRangeHistoryDialog(self.enricher.mac_history_db, self)
        dialog.exec_()
    
    def on_title_click(self, event):
        if not self.engineering_mode:
            password, ok = QInputDialog.getText(self, "Вход в инженерное меню", 
                "Введите пароль для доступа к инженерному меню:\n(По умолчанию: admin123)")
            if ok:
                if password == "admin123":
                    self.engineering_mode = True
                    self.apply_mode()
                    self.logger.log_action("Вход в инженерное меню", "Успешно")
                    QMessageBox.information(self, "Доступ разрешен", 
                        "Вы вошли в ИНЖЕНЕРНЫЙ РЕЖИМ.\n"
                        "Теперь доступны все функции программы.\n"
                        "Для выхода нажмите кнопку 'Выйти в пользовательский режим'.")
                else:
                    QMessageBox.warning(self, "Ошибка", "Неверный пароль!")
    
    def exit_engineering_mode(self):
        reply = QMessageBox.question(self, "Выход из инженерного режима", 
            "Вы действительно хотите выйти из инженерного режима?\n"
            "Вы перейдете в пользовательский режим с ограниченным функционалом.\n\n"
            "Для повторного входа потребуется ввести пароль.",
            QMessageBox.Yes | QMessageBox.No)
        
        if reply == QMessageBox.Yes:
            self.engineering_mode = False
            self.apply_mode()
            self.logger.log_action("Выход из инженерного режима", "")
            QMessageBox.information(self, "Выход выполнен", 
                "Вы перешли в ПОЛЬЗОВАТЕЛЬСКИЙ РЕЖИМ.\n"
                "Теперь доступен только поиск по истории.\n"
                "Для возврата в инженерный режим нажмите на название программы.")
    
    def apply_mode(self):
        if self.engineering_mode:
            self.setWindowTitle("MAC Analyzer Pro - Full Edition 9.0 (ИНЖЕНЕРНЫЙ РЕЖИМ)")
            self.mode_label.setText("🔧 ИНЖЕНЕРНЫЙ РЕЖИМ")
            self.mode_label.setStyleSheet("color: #ff6b6b; font-size: 11px; font-weight: bold; background-color: #3c2a2a; padding: 4px 8px; border-radius: 4px;")
            
            self.nav_widget.show()
            self.stacked_widget.show()
            self.search_panel.hide()
            self.exit_eng_btn.show()
            self.switch_to_section("enrichment")
            self.update_nav_buttons_style()
            
            self.export_btn.setEnabled(bool(self.current_devices))
            self.analytics_btn.setEnabled(bool(self.current_devices))
            
            self.status_bar.showMessage("Инженерный режим - доступны все функции")
        else:
            self.setWindowTitle("MAC Analyzer Pro - Full Edition 9.0 (ПОЛЬЗОВАТЕЛЬСКИЙ РЕЖИМ)")
            self.mode_label.setText("👤 ПОЛЬЗОВАТЕЛЬСКИЙ РЕЖИМ")
            self.mode_label.setStyleSheet("color: #ffab40; font-size: 11px; font-weight: bold; background-color: #2d2d2d; padding: 4px 8px; border-radius: 4px;")
            
            self.nav_widget.hide()
            self.stacked_widget.hide()
            self.search_panel.show()
            self.exit_eng_btn.hide()
            
            self.export_btn.setEnabled(bool(self.current_devices))
            self.analytics_btn.setEnabled(bool(self.current_devices))
            
            self.load_search_data()
            
            self.status_bar.showMessage("Пользовательский режим - доступен поиск по истории MAC-адресов, производителей и моделей, а также аналитика и экспорт")
    
    def load_search_data(self):
        all_data = self.enricher.search_all("")
        
        self.search_data = []
        for item in all_data:
            self.search_data.append({
                'type': 'MAC-адрес',
                'mac': item['mac'],
                'mac_formatted': item['mac_formatted'],
                'vendor': item['vendor'],
                'model': item['model'],
                'ip': item['ip'],
                'address': item['address'],
                'room': item['room'],
                'switch_ip': item['switch_ip'],
                'switch_port': item['switch_port'],
                'last_seen': item['last_seen']
            })
        
        vendors = self.enricher.history_enricher.history_db.get_all_vendors()
        models = self.enricher.history_enricher.history_db.get_all_models()
        
        for v in vendors:
            self.search_data.append({
                'type': 'Производитель',
                'mac': '',
                'mac_formatted': '',
                'vendor': v[1],
                'model': '',
                'ip': '',
                'address': '',
                'room': '',
                'switch_ip': '',
                'switch_port': '',
                'last_seen': v[3][:10] if v[3] else '-'
            })
        
        for m in models:
            self.search_data.append({
                'type': 'Модель',
                'mac': '',
                'mac_formatted': '',
                'vendor': '',
                'model': m[1],
                'ip': '',
                'address': '',
                'room': '',
                'switch_ip': '',
                'switch_port': '',
                'last_seen': m[3][:10] if m[3] else '-'
            })
        
        self.display_search_results(self.search_data)
    
    def display_search_results(self, data):
        if not data:
            self.results_table.setRowCount(0)
            self.results_table.setColumnCount(0)
            return
        
        headers = ["Тип", "MAC-адрес", "Производитель", "Модель", "IP-адрес", "Физический адрес", "Помещение", "IP коммутатора", "Порт", "Последнее"]
        self.results_table.setColumnCount(len(headers))
        self.results_table.setHorizontalHeaderLabels(headers)
        self.results_table.setRowCount(len(data))
        
        for i, item in enumerate(data):
            self.results_table.setItem(i, 0, QTableWidgetItem(item['type']))
            
            mac_display = item['mac_formatted'] if item['mac_formatted'] else (item['mac'] if item['mac'] else '-')
            mac_item = QTableWidgetItem(mac_display)
            mac_item.setData(Qt.UserRole, item['mac'])
            self.results_table.setItem(i, 1, mac_item)
            
            self.results_table.setItem(i, 2, QTableWidgetItem(item['vendor'] if item['vendor'] else '-'))
            self.results_table.setItem(i, 3, QTableWidgetItem(item['model'] if item['model'] else '-'))
            self.results_table.setItem(i, 4, QTableWidgetItem(item['ip'] if item['ip'] else '-'))
            self.results_table.setItem(i, 5, QTableWidgetItem(item['address'] if item['address'] else '-'))
            self.results_table.setItem(i, 6, QTableWidgetItem(item['room'] if item['room'] else '-'))
            self.results_table.setItem(i, 7, QTableWidgetItem(item['switch_ip'] if item['switch_ip'] else '-'))
            self.results_table.setItem(i, 8, QTableWidgetItem(item['switch_port'] if item['switch_port'] else '-'))
            self.results_table.setItem(i, 9, QTableWidgetItem(item['last_seen'] if item['last_seen'] else '-'))
        
        self.results_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
    
    def filter_search(self):
        text = self.search_line.text().lower()
        if not text or not hasattr(self, 'search_data'):
            if hasattr(self, 'search_data'):
                self.display_search_results(self.search_data)
            return
        
        filtered = []
        search_type = getattr(self, 'current_search_type', 'all')
        for item in self.search_data:
            if search_type == 'mac' and item['type'] != 'MAC-адрес':
                continue
            if search_type == 'vendor' and item['type'] != 'Производитель':
                continue
            if search_type == 'model' and item['type'] != 'Модель':
                continue
            if (text in item['type'].lower() or 
                text in item['vendor'].lower() or 
                text in item['model'].lower() or
                text in item['mac'].lower() or
                text in item['mac_formatted'].lower() or
                text in item['ip'].lower() or
                text in item['address'].lower()):
                filtered.append(item)
        
        self.display_search_results(filtered)
    
    def set_search_type(self, search_type):
        self.current_search_type = search_type
        self.filter_search()
    
    def clear_search(self):
        self.search_line.clear()
        self.current_search_type = 'all'
        if hasattr(self, 'search_data'):
            self.display_search_results(self.search_data)
    
    def on_item_double_click(self, index):
        item_type = self.results_table.item(index.row(), 0).text()
        
        if item_type == 'MAC-адрес':
            mac_item = self.results_table.item(index.row(), 1)
            if mac_item:
                mac = mac_item.data(Qt.UserRole)
                if mac:
                    last_info = self.enricher.mac_history_db.get_mac_last_info(mac)
                    if last_info:
                        device = {
                            'mac': mac,
                            'mac_formatted': last_info.get('mac_formatted', MACValidator.format_mac(mac)),
                            'vendor': last_info.get('vendor', 'Unknown'),
                            'model': last_info.get('model', ''),
                            'ip': last_info.get('ip', ''),
                            'address': last_info.get('address', ''),
                            'room': last_info.get('room', ''),
                            'switch_ip': last_info.get('switch_ip', ''),
                            'switch_port': last_info.get('switch_port', ''),
                            'vendor_confidence': 0,
                            'model_confidence': 0,
                            'vendor_source': 'Из истории',
                            'model_source': 'Из истории',
                            'match_details': 'Данные из истории'
                        }
                        
                        history = self.enricher.mac_history_db.get_mac_history(mac)
                        if history:
                            last_record = history[-1]
                            device['vendor_confidence'] = last_record.get('vendor_confidence', 0)
                            device['model_confidence'] = last_record.get('model_confidence', 0)
                            device['vendor_source'] = last_record.get('vendor_source', 'Из истории')
                            device['model_source'] = last_record.get('model_source', 'Из истории')
                        
                        reply = QMessageBox.question(self, "Выбор действия", 
                            f"Выберите действие для MAC-адреса {last_info.get('mac_formatted', MACValidator.format_mac(mac))}:\n\n"
                            "Да - показать историю\n"
                            "Нет - показать аналитику устройства\n"
                            "Отмена - закрыть",
                            QMessageBox.Yes | QMessageBox.No | QMessageBox.Cancel)
                        
                        if reply == QMessageBox.Yes:
                            dialog = MACHistoryDialog(mac, self.enricher.mac_history_db, self)
                            dialog.exec_()
                        elif reply == QMessageBox.No:
                            dialog = SingleDeviceAnalyticsDialog(mac, device, self)
                            dialog.exec_()
                    else:
                        dialog = MACHistoryDialog(mac, self.enricher.mac_history_db, self)
                        dialog.exec_()
        
        elif item_type == 'Модель':
            model_name = self.results_table.item(index.row(), 3).text()
            if model_name and model_name != '-':
                dialog = ModelPrefixesDialog(model_name, self)
                dialog.exec_()
    
    def show_search_dialog(self):
        if not self.engineering_mode:
            return
        if not self.current_devices:
            QMessageBox.warning(self, "Ошибка", "Нет данных для поиска!")
            return
        text, ok = QInputDialog.getText(self, "Расширенный поиск", "Введите текст для поиска:\n(можно использовать части слов)")
        if ok and text:
            self.search_line.setText(text)
            self.filter_search()
    
    def create_enrichment_panel(self):
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setSpacing(10)
        
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll_widget = QWidget()
        scroll_layout = QVBoxLayout(scroll_widget)
        
        file_group = QGroupBox("Выбор файлов для обогащения")
        file_layout = QVBoxLayout()
        file_layout.setSpacing(8)
        
        main_widget = QWidget()
        main_w_layout = QHBoxLayout(main_widget)
        main_w_layout.setContentsMargins(0, 0, 0, 0)
        self.main_file_edit = QLineEdit()
        self.main_file_edit.setPlaceholderText("Выберите основной файл...")
        main_btn = QPushButton("Обзор")
        main_btn.setFixedWidth(80)
        main_btn.clicked.connect(self.browse_main)
        main_w_layout.addWidget(QLabel("Основной:"))
        main_w_layout.addWidget(self.main_file_edit, 1)
        main_w_layout.addWidget(main_btn)
        file_layout.addWidget(main_widget)
        
        add_widget = QWidget()
        add_w_layout = QHBoxLayout(add_widget)
        add_w_layout.setContentsMargins(0, 0, 0, 0)
        self.add_file_edit = QLineEdit()
        self.add_file_edit.setPlaceholderText("Выберите дополнительный файл...")
        add_btn = QPushButton("Обзор")
        add_btn.setFixedWidth(80)
        add_btn.clicked.connect(self.browse_additional)
        add_w_layout.addWidget(QLabel("Дополнит.:"))
        add_w_layout.addWidget(self.add_file_edit, 1)
        add_w_layout.addWidget(add_btn)
        file_layout.addWidget(add_widget)
        
        self.files_list = DropAreaListWidget(self)
        self.files_list.setMaximumHeight(100)
        file_layout.addWidget(self.files_list)
        
        list_btn_widget = QWidget()
        list_btn_layout = QHBoxLayout(list_btn_widget)
        list_btn_layout.setContentsMargins(0, 0, 0, 0)
        add_list_btn = QPushButton("Добавить в список")
        add_list_btn.clicked.connect(self.add_to_list)
        remove_btn = QPushButton("Удалить")
        remove_btn.clicked.connect(self.remove_from_list)
        list_btn_layout.addWidget(add_list_btn)
        list_btn_layout.addWidget(remove_btn)
        file_layout.addWidget(list_btn_widget)
        
        file_group.setLayout(file_layout)
        scroll_layout.addWidget(file_group)
        
        strategy_group = QGroupBox("Стратегия обработки строк")
        strategy_layout = QVBoxLayout()
        self.strategy_keep_only = QRadioButton("Только обогащение существующих строк")
        self.strategy_keep_only.setChecked(True)
        self.strategy_add_new = QRadioButton("Обогащение с добавлением новых строк")
        strategy_layout.addWidget(self.strategy_keep_only)
        strategy_layout.addWidget(self.strategy_add_new)
        strategy_info = QLabel("'Только обогащение' - количество строк не изменится\n'С добавлением' - появятся новые строки")
        strategy_info.setStyleSheet("color: #888; font-size: 11px;")
        strategy_info.setWordWrap(True)
        strategy_layout.addWidget(strategy_info)
        strategy_group.setLayout(strategy_layout)
        scroll_layout.addWidget(strategy_group)
        
        btn_group = QGroupBox("Действия")
        btn_layout = QVBoxLayout()
        
        self.map_columns_btn = QPushButton("Настройка колонок для файлов")
        self.map_columns_btn.clicked.connect(self.configure_columns)
        btn_layout.addWidget(self.map_columns_btn)
        
        self.fields_btn = QPushButton("Настройка полей")
        self.fields_btn.clicked.connect(self.configure_fields)
        btn_layout.addWidget(self.fields_btn)
        
        self.ai_btn = QPushButton("AI-анализ")
        self.ai_btn.clicked.connect(self.ai_analysis)
        btn_layout.addWidget(self.ai_btn)
        
        self.cluster_btn = QPushButton("Кластеризация")
        self.cluster_btn.clicked.connect(self.show_clustering)
        btn_layout.addWidget(self.cluster_btn)
        
        self.settings_btn = QPushButton("⚙️ Настройки определения")
        self.settings_btn.clicked.connect(self.show_settings_dialog)
        btn_layout.addWidget(self.settings_btn)
        
        self.history_settings_btn = QPushButton("📚 Настройка исторического обогащения")
        self.history_settings_btn.clicked.connect(self.show_history_enrichment_settings)
        btn_layout.addWidget(self.history_settings_btn)
        
        self.start_btn = QPushButton("Запустить обогащение")
        self.start_btn.clicked.connect(self.start_enrichment)
        btn_layout.addWidget(self.start_btn)
        
        cancel_btn = QPushButton("Отменить операцию")
        cancel_btn.clicked.connect(self.cancel_enrichment)
        btn_layout.addWidget(cancel_btn)
        
        btn_group.setLayout(btn_layout)
        scroll_layout.addWidget(btn_group)
        
        scroll_layout.addStretch()
        scroll.setWidget(scroll_widget)
        layout.addWidget(scroll)
        
        return widget
    
    def create_compare_panel(self):
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setSpacing(15)
        
        btn_compare2 = QPushButton("Сравнение двух файлов")
        btn_compare2.clicked.connect(self.open_file_comparison)
        layout.addWidget(btn_compare2)
        
        label1 = QLabel("Сравнение двух файлов с детальным отчетом 'Было / Стало'")
        label1.setWordWrap(True)
        label1.setStyleSheet("color: #888; padding-left: 20px;")
        layout.addWidget(label1)
        
        line = QFrame()
        line.setFrameShape(QFrame.HLine)
        line.setFrameShadow(QFrame.Sunken)
        layout.addWidget(line)
        
        btn_multicompare = QPushButton("Сравнение нескольких файлов")
        btn_multicompare.clicked.connect(self.open_multi_file_comparison)
        layout.addWidget(btn_multicompare)
        
        label2 = QLabel("Сравнение до 10 файлов одновременно. Для каждого файла можно настроить колонки.")
        label2.setWordWrap(True)
        label2.setStyleSheet("color: #888; padding-left: 20px;")
        layout.addWidget(label2)
        
        layout.addStretch()
        return widget
    
    def create_stats_panel(self):
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setSpacing(10)
        
        stats_group = QGroupBox("📊 Аналитика")
        stats_layout = QVBoxLayout()
        
        timestats_btn = QPushButton("📈 Динамика изменений")
        timestats_btn.clicked.connect(self.show_timestats)
        stats_layout.addWidget(timestats_btn)
        
        charts_btn = QPushButton("📊 Графики и диаграммы")
        charts_btn.clicked.connect(self.show_charts)
        stats_layout.addWidget(charts_btn)
        
        topology_btn = QPushButton("🗺️ Топология сети")
        topology_btn.clicked.connect(self.show_topology)
        stats_layout.addWidget(topology_btn)
        
        cluster_btn = QPushButton("🎯 Кластеризация устройств")
        cluster_btn.clicked.connect(self.show_clustering)
        stats_layout.addWidget(cluster_btn)
        
        stats_group.setLayout(stats_layout)
        layout.addWidget(stats_group)
        
        layout.addStretch()
        return widget
    
    def create_settings_panel(self):
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setSpacing(10)
        
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll_widget = QWidget()
        scroll_layout = QVBoxLayout(scroll_widget)
        scroll_layout.setSpacing(10)
        
        detection_group = QGroupBox("🔍 Определение устройств")
        detection_layout = QVBoxLayout()
        
        vendor_settings_btn = QPushButton("🏭 Определение производителя и модели")
        vendor_settings_btn.clicked.connect(self.show_vendor_settings)
        detection_layout.addWidget(vendor_settings_btn)
        
        ip_mapping_btn = QPushButton("🏠 IP коммутатора → Физический адрес")
        ip_mapping_btn.clicked.connect(self.show_ip_address_mapping)
        detection_layout.addWidget(ip_mapping_btn)
        
        detection_group.setLayout(detection_layout)
        scroll_layout.addWidget(detection_group)
        
        history_group = QGroupBox("📚 История и обучение")
        history_layout = QVBoxLayout()
        
        history_settings_btn = QPushButton("⚙️ Настройка исторического обогащения")
        history_settings_btn.clicked.connect(self.show_history_enrichment_settings)
        history_layout.addWidget(history_settings_btn)
        
        history_view_btn = QPushButton("📊 Просмотр истории производителей и моделей")
        history_view_btn.clicked.connect(self.show_vendor_history)
        history_layout.addWidget(history_view_btn)
        
        mac_history_btn = QPushButton("📋 Просмотр истории MAC-адресов")
        mac_history_btn.clicked.connect(self.show_mac_history_dialog)
        history_layout.addWidget(mac_history_btn)
        
        history_group.setLayout(history_layout)
        scroll_layout.addWidget(history_group)
        
        api_group = QGroupBox("🌐 API интеграция")
        api_layout = QVBoxLayout()
        
        api_settings_btn = QPushButton("🔑 Настройка API сервисов")
        api_settings_btn.clicked.connect(self.show_api_settings)
        api_layout.addWidget(api_settings_btn)
        
        api_enrich_btn = QPushButton("🚀 Обогащение через API")
        api_enrich_btn.clicked.connect(self.show_api_enrichment)
        api_layout.addWidget(api_enrich_btn)
        
        api_info = QLabel("API позволяет получать информацию о производителях MAC-адресов из внешних источников:\n• macvendors.com\n• maclookup.app\n• mac2vendor.com")
        api_info.setWordWrap(True)
        api_info.setStyleSheet("color: #888; font-size: 11px; padding: 5px;")
        api_layout.addWidget(api_info)
        
        api_group.setLayout(api_layout)
        scroll_layout.addWidget(api_group)
        
        display_group = QGroupBox("📊 Отображение и экспорт")
        display_layout = QVBoxLayout()
        
        columns_btn = QPushButton("📋 Управление колонками результатов")
        columns_btn.clicked.connect(self.manage_columns)
        display_layout.addWidget(columns_btn)
        
        oui_btn = QPushButton("🔢 Форматы OUI")
        oui_btn.clicked.connect(self.change_oui_formats)
        display_layout.addWidget(oui_btn)
        
        display_group.setLayout(display_layout)
        scroll_layout.addWidget(display_group)
        
        automation_group = QGroupBox("⚡ Автоматизация")
        automation_layout = QVBoxLayout()
        
        scheduler_btn = QPushButton("⏰ Планировщик задач")
        scheduler_btn.clicked.connect(self.show_scheduler)
        automation_layout.addWidget(scheduler_btn)
        
        notification_btn = QPushButton("📧 Оповещения")
        notification_btn.clicked.connect(self.show_notification_settings)
        automation_layout.addWidget(notification_btn)
        
        single_file_btn = QPushButton("📄 Анализ одного файла")
        single_file_btn.clicked.connect(self.single_file_analysis)
        automation_layout.addWidget(single_file_btn)
        
        automation_group.setLayout(automation_layout)
        scroll_layout.addWidget(automation_group)
        
        system_group = QGroupBox("🖥️ Система")
        system_layout = QVBoxLayout()
        
        theme_btn_settings = QPushButton("🎨 Сменить тему оформления")
        theme_btn_settings.clicked.connect(self.show_theme_selector)
        system_layout.addWidget(theme_btn_settings)
        
        system_group.setLayout(system_layout)
        scroll_layout.addWidget(system_group)
        
        scroll_layout.addStretch()
        scroll.setWidget(scroll_widget)
        layout.addWidget(scroll)
        
        info_frame = QFrame()
        info_frame.setFrameShape(QFrame.StyledPanel)
        info_frame.setStyleSheet("background-color: #2d2d2d; border-radius: 5px;")
        info_layout = QVBoxLayout(info_frame)
        
        info_title = QLabel("💡 Советы по использованию")
        info_title.setStyleSheet("font-weight: bold; color: #ffab40;")
        info_layout.addWidget(info_title)
        
        tips = QLabel(
            "• Настройте определение производителя для точного распознавания устройств\n"
            "• Настройте соответствия IP→адрес для автоматического определения локации\n"
            "• Включите историческое обогащение для накопления знаний о вашей сети\n"
            "• Используйте API для получения данных из внешних источников\n"
            "• Настройте колонки результатов для удобного просмотра данных\n"
            "• Двойной клик по MAC-адресу покажет полную историю или аналитику устройства\n"
            "• Двойной клик по модели покажет все префиксы MAC для этой модели\n"
            "• Используйте кнопку 'Экспорт результатов' для сохранения данных в 7+ форматах\n"
            "• Используйте кнопку 'Аналитика' для получения статистики по всем устройствам"
        )
        tips.setWordWrap(True)
        tips.setStyleSheet("color: #ccc; font-size: 11px;")
        info_layout.addWidget(tips)
        
        layout.addWidget(info_frame)
        
        return widget
    
    def show_mac_history_dialog(self):
        if not self.engineering_mode:
            return
        mac, ok = QInputDialog.getText(self, "История MAC-адреса", 
            "Введите MAC-адрес для просмотра истории (в любом формате):")
        if ok and mac:
            normalized = MACValidator.normalize(mac)
            if normalized:
                dialog = MACHistoryDialog(normalized, self.enricher.mac_history_db, self)
                dialog.exec_()
            else:
                QMessageBox.warning(self, "Ошибка", "Неверный формат MAC-адреса!")
    
    def switch_to_section(self, section):
        if not self.engineering_mode:
            return
        sections = {"enrichment": 0, "compare": 1, "stats": 2, "settings": 3}
        if section in sections:
            self.current_section = section
            self.stacked_widget.setCurrentIndex(sections[section])
            self.update_nav_buttons_style()
        self.status_bar.showMessage(f"Раздел: {self._get_section_name(section)}")
    
    def _get_section_name(self, section):
        names = {
            "enrichment": "Обогащение данных",
            "compare": "Сравнение файлов",
            "stats": "Статистика и графики",
            "settings": "Настройки"
        }
        return names.get(section, section)
    
    def show_results(self):
        if not self.engineering_mode:
            return
        if hasattr(self, 'results_table') and self.results_table.rowCount() > 0:
            self.results_table.scrollToTop()
            self.results_table.setFocus()
            self.status_bar.showMessage("Переход к результатам")
        else:
            self.status_bar.showMessage("Нет результатов для отображения")
    
    def show_vendor_settings(self):
        if not self.engineering_mode:
            return
        dialog = VendorDetectorSettingsDialog(self.enricher, self)
        dialog.exec_()
    
    def show_ip_address_mapping(self):
        if not self.engineering_mode:
            return
        dialog = IPAddressMappingDialog(self.enricher, self)
        dialog.exec_()
    
    def show_history_enrichment_settings(self):
        if not self.engineering_mode:
            return
        dialog = HistoryEnrichmentSettingsDialog(self.enricher.history_enricher, self)
        dialog.exec_()
    
    def show_vendor_history(self):
        dialog = VendorModelHistoryDialog(self.enricher.history_enricher, self)
        dialog.exec_()
    
    def show_settings_dialog(self):
        if not self.engineering_mode:
            return
        dialog = QDialog(self)
        dialog.setWindowTitle("Настройки обогащения")
        dialog.setModal(True)
        dialog.setGeometry(300, 300, 500, 400)
        
        layout = QVBoxLayout(dialog)
        
        vendor_btn = QPushButton("🏭 Настройка определения производителя и модели")
        vendor_btn.clicked.connect(lambda: self.show_vendor_settings())
        layout.addWidget(vendor_btn)
        
        ip_btn = QPushButton("🏠 Настройка IP коммутатора → Адрес")
        ip_btn.clicked.connect(lambda: self.show_ip_address_mapping())
        layout.addWidget(ip_btn)
        
        history_btn = QPushButton("📚 Настройка исторического обогащения")
        history_btn.clicked.connect(lambda: self.show_history_enrichment_settings())
        layout.addWidget(history_btn)
        
        layout.addStretch()
        
        close_btn = QPushButton("Закрыть")
        close_btn.clicked.connect(dialog.accept)
        layout.addWidget(close_btn)
        
        dialog.exec_()
    
    def show_charts(self):
        if not self.engineering_mode:
            return
        if not self.current_devices:
            QMessageBox.warning(self, "Ошибка", "Нет данных для отображения графиков!")
            return
        if self.chart_widget is None:
            self.chart_widget = AnalyticsChart(self.current_devices)
        self.chart_widget.show()
        self.chart_widget.raise_()
    
    def show_topology(self):
        if not self.engineering_mode:
            return
        if not self.current_devices:
            QMessageBox.warning(self, "Ошибка", "Нет данных для отображения топологии!")
            return
        if self.topology_widget is None:
            self.topology_widget = NetworkTopologyWidget(self.current_devices)
        self.topology_widget.show()
        self.topology_widget.raise_()
    
    def show_clustering(self):
        if not self.engineering_mode:
            return
        if not self.current_devices:
            QMessageBox.warning(self, "Ошибка", "Нет данных для кластеризации!")
            return
        dialog = ClusteringDialog(self.current_devices, self)
        dialog.exec_()
    
    def show_theme_selector(self):
        dialog = ThemeSelectionDialog(self)
        dialog.exec_()
    
    def show_api_settings(self):
        if not self.engineering_mode:
            return
        dialog = APISettingsDialog(self.api_client, self)
        dialog.exec_()
    
    def show_api_enrichment(self):
        if not self.engineering_mode:
            return
        if not self.current_devices:
            QMessageBox.warning(self, "Ошибка", "Нет данных для API обогащения!")
            return
        dialog = APIEnrichmentDialog(self.api_client, self)
        dialog.exec_()
    
    def configure_fields(self):
        if not self.engineering_mode:
            return
        dialog = FieldsSelectionDialog(self.comparison_fields, self.enrich_fields, self)
        if dialog.exec_():
            settings = dialog.get_settings()
            self.comparison_fields = settings['comparison_fields']
            self.enrich_fields = settings['enrich_fields']
            self.logger.log_action("Настройки полей обновлены", str(self.comparison_fields))
            self.status_bar.showMessage("Настройки полей сохранены")
    
    def add_file_external(self, filepath):
        if not self.engineering_mode:
            return
        alias = Path(filepath).stem
        is_primary = len(self.enricher.files) == 0
        self.enricher.add_file(filepath, alias, is_primary)
        if is_primary:
            self.main_file_edit.setText(filepath)
        self.update_file_list()
        self.logger.log_action("Файл добавлен через Drag-n-Drop", filepath)
    
    def browse_main(self):
        if not self.engineering_mode:
            return
        f, _ = QFileDialog.getOpenFileName(self, "Выберите основной файл", "", "Excel Files (*.xlsx *.xls *.csv)")
        if f:
            self.main_file_edit.setText(f)
            self.enricher.add_file(f, Path(f).stem, True)
            self.update_file_list()
            self.logger.log_action("Основной файл выбран", f)
    
    def browse_additional(self):
        if not self.engineering_mode:
            return
        f, _ = QFileDialog.getOpenFileName(self, "Выберите дополнительный файл", "", "Excel Files (*.xlsx *.xls *.csv)")
        if f:
            self.add_file_edit.setText(f)
    
    def add_to_list(self):
        if not self.engineering_mode:
            return
        f = self.add_file_edit.text()
        if f and os.path.exists(f):
            alias = Path(f).stem
            if alias in self.enricher.files:
                QMessageBox.warning(self, "Ошибка", f"Файл '{alias}' уже добавлен!")
                return
            self.enricher.add_file(f, alias, False)
            self.add_file_edit.clear()
            self.update_file_list()
            self.logger.log_action("Дополнительный файл добавлен", f)
    
    def remove_from_list(self):
        if not self.engineering_mode:
            return
        r = self.files_list.currentRow()
        if r >= 0:
            item_text = self.files_list.item(r).text()
            alias = item_text[2:] if item_text.startswith(("📁 ", "📄 ")) else item_text
            if alias in self.enricher.files:
                if self.enricher.files[alias]['is_primary']:
                    self.enricher.primary_alias = None
                    self.enricher.primary_devices = []
                    self.main_file_edit.clear()
                del self.enricher.files[alias]
                self.files_list.takeItem(r)
                self.update_file_list()
                self.logger.log_action("Файл удален", alias)
    
    def update_file_list(self):
        if not self.engineering_mode:
            return
        self.files_list.clear()
        for alias, info in self.enricher.files.items():
            icon = "📁" if info['is_primary'] else "📄"
            self.files_list.addItem(f"{icon} {alias}")
    
    def configure_columns(self):
        if not self.engineering_mode:
            return
        if not self.enricher.files:
            QMessageBox.warning(self, "Ошибка", "Сначала добавьте файлы!")
            return
        dialog = ColumnMappingDialog(self.enricher, self)
        if dialog.exec_():
            QMessageBox.information(self, "Успех", "Настройки колонок для файлов сохранены!")
            self.status_bar.showMessage("Настройки колонок сохранены")
    
    def manage_columns(self):
        if not self.engineering_mode:
            return
        dialog = ColumnManagerDialog(self.column_manager, self)
        if dialog.exec_():
            if self.current_devices:
                self.display_results(self.current_devices)
            self.save_settings()
            self.status_bar.showMessage(f"Обновлено отображение колонок ({len(self.column_manager.get_visible_columns())} колонок)")
    
    def change_oui_formats(self):
        if not self.engineering_mode:
            return
        dialog = OUIFormatSelectionDialog(self.oui_formats, self)
        if dialog.exec_():
            self.oui_formats = dialog.get_selected_formats()
            self.enricher.set_oui_formats(self.oui_formats)
            self.logger.log_action("Форматы OUI изменены", self._get_formats_text())
            self.status_bar.showMessage(f"Форматы OUI обновлены: {self._get_formats_text()}")
    
    def _get_formats_text(self):
        formats = []
        if self.oui_formats.get(3, False): formats.append("3")
        if self.oui_formats.get(4, False): formats.append("4")
        if self.oui_formats.get(5, False): formats.append("5")
        if self.oui_formats.get(6, False): formats.append("6")
        return f"{'+'.join(formats)} байт" if formats else "не выбраны"
    
    def setup_shortcuts(self):
        QShortcut(QKeySequence("Ctrl+O"), self).activated.connect(self.browse_main)
        QShortcut(QKeySequence("Ctrl+S"), self).activated.connect(self.save_results)
        QShortcut(QKeySequence("Ctrl+E"), self).activated.connect(self.export_results)
        QShortcut(QKeySequence("Ctrl+A"), self).activated.connect(self.show_analytics_dialog)
        QShortcut(QKeySequence("Ctrl+H"), self).activated.connect(self.show_date_range_history)
        QShortcut(QKeySequence("F5"), self).activated.connect(self.start_enrichment)
        QShortcut(QKeySequence("F6"), self).activated.connect(self.open_file_comparison)
        QShortcut(QKeySequence("F7"), self).activated.connect(self.show_charts)
        QShortcut(QKeySequence("F8"), self).activated.connect(self.show_topology)
        QShortcut(QKeySequence("F9"), self).activated.connect(self.open_multi_file_comparison)
        QShortcut(QKeySequence("F1"), self).activated.connect(self.help_system)
        QShortcut(QKeySequence("Ctrl+F"), self).activated.connect(lambda: self.search_line.setFocus())
        QShortcut(QKeySequence("Ctrl+Shift+C"), self).activated.connect(self.manage_columns)
        QShortcut(QKeySequence("Esc"), self).activated.connect(self.cancel_enrichment)
    
    def load_settings(self):
        (geometry, last_strategy, oui_formats, visible_columns, comparison_fields,
         enrich_fields, theme, api_settings, custom_columns, ip_mapping_file, auto_detect_ip, 
         ip_enrichment_settings, vendor_detector_settings, history_enricher_settings, engineering_mode) = self.settings_manager.load_settings(self.enricher)
        if geometry:
            self.restoreGeometry(geometry)
        if last_strategy:
            self.row_strategy = last_strategy
            if last_strategy == "add_new_rows":
                self.strategy_add_new.setChecked(True)
            else:
                self.strategy_keep_only.setChecked(True)
        if oui_formats:
            self.oui_formats = oui_formats
            self.enricher.set_oui_formats(self.oui_formats)
        if visible_columns:
            self.column_manager.set_visible_columns(visible_columns)
        if comparison_fields:
            self.comparison_fields = comparison_fields
        if enrich_fields:
            self.enrich_fields = enrich_fields
        if theme:
            self.apply_theme(theme)
        if api_settings:
            self.api_client.service = api_settings.get('service', 'macvendors')
            self.api_client.api_key = api_settings.get('api_key')
        if custom_columns:
            for col in custom_columns:
                self.column_manager.add_custom_column(col)
        if ip_mapping_file and os.path.exists(ip_mapping_file):
            self.enricher.load_ip_address_mapping(ip_mapping_file)
        if auto_detect_ip and self.enricher.primary_devices:
            self.enricher.auto_detect_ip_address_mapping()
        if ip_enrichment_settings:
            self.enricher.set_ip_enrichment_settings(
                enabled=ip_enrichment_settings.get('enabled', True),
                partial_match=ip_enrichment_settings.get('partial_match', True),
                overwrite=ip_enrichment_settings.get('overwrite', False)
            )
        if vendor_detector_settings:
            self.enricher.set_vendor_detector_settings(
                enabled=vendor_detector_settings.get('enabled', True),
                use_oui_3byte=vendor_detector_settings.get('use_oui_3byte', True),
                use_oui_5byte=vendor_detector_settings.get('use_oui_5byte', True),
                use_text=vendor_detector_settings.get('use_text_analysis', True),
                use_inference=vendor_detector_settings.get('use_inference', True),
                confidence_threshold=vendor_detector_settings.get('confidence_threshold', 0.6)
            )
        if history_enricher_settings:
            self.enricher.set_history_enrichment_settings(
                enabled=history_enricher_settings.get('enabled', True),
                priority_history=history_enricher_settings.get('priority_history', True),
                use_oui_match=history_enricher_settings.get('use_oui_match', True),
                use_mac5_match=history_enricher_settings.get('use_mac5_match', True)
            )
        self.engineering_mode = engineering_mode
        self.apply_mode()
        self.update_file_list()
        self.logger.log_action("Настройки загружены", f"engineering_mode={engineering_mode}")
    
    def save_settings(self):
        self.settings_manager.save_settings(
            self.enricher, self.saveGeometry(), self.row_strategy,
            oui_formats=self.oui_formats, visible_columns=self.column_manager.get_visible_columns(),
            comparison_fields=self.comparison_fields, enrich_fields=self.enrich_fields, theme=self.current_theme,
            api_settings={'service': self.api_client.service, 'api_key': self.api_client.api_key},
            custom_columns=self.column_manager.get_custom_columns(),
            ip_address_mapping_file=self.enricher.ip_address_mapper.mapping_file,
            auto_detect_address_by_ip=True,
            ip_enrichment_settings={
                'enabled': self.enricher.ip_address_mapper.enrichment_enabled,
                'partial_match': self.enricher.ip_address_mapper.partial_match_enabled,
                'overwrite': self.enricher.ip_address_mapper.overwrite_existing
            },
            vendor_detector_settings=self.enricher.get_vendor_detector_stats(),
            history_enricher_settings={
                'enabled': self.enricher.history_enricher.enabled,
                'priority_history': self.enricher.history_enricher.priority_history,
                'use_oui_match': self.enricher.history_enricher.use_oui_match,
                'use_mac5_match': self.enricher.history_enricher.use_mac5_match
            },
            engineering_mode=self.engineering_mode
        )
    
    def closeEvent(self, event):
        if self.chart_widget:
            self.chart_widget.cleanup()
        if self.topology_widget:
            self.topology_widget.cleanup()
        if self.worker and self.worker.isRunning():
            self.worker.cancel()
            self.worker.wait(3000)
        self.auto_save_manager.stop()
        self.save_settings()
        self.logger.log_action("Программа закрыта", "")
        event.accept()
    
    def cancel_enrichment(self):
        if not self.engineering_mode:
            return
        if self.worker and self.worker.isRunning():
            reply = QMessageBox.question(self, "Отмена", "Вы действительно хотите отменить операцию обогащения?",
                                        QMessageBox.Yes | QMessageBox.No)
            if reply == QMessageBox.Yes:
                self.worker.cancel()
                self.status_bar.showMessage("Отмена операции...")
                if self.progress_dialog:
                    self.progress_dialog.close()
    
    def ai_analysis(self):
        if not self.engineering_mode:
            return
        if not self.current_devices:
            QMessageBox.warning(self, "Ошибка", "Сначала выполните обогащение!")
            return
        issues, recommendations = self.ai_assistant.analyze_data_quality(self.current_devices)
        msg = "AI-АНАЛИЗ ДАННЫХ\n\n"
        if issues:
            msg += "ОБНАРУЖЕННЫЕ ПРОБЛЕМЫ:\n" + "\n".join(f"   {issue}" for issue in issues) + "\n\n"
        if recommendations:
            msg += "РЕКОМЕНДАЦИИ:\n" + "\n".join(f"   • {rec}" for rec in recommendations)
        if not issues and not recommendations:
            msg += "Качество данных хорошее! Проблем не обнаружено."
        QMessageBox.information(self, "AI-анализ", msg)
    
    def open_file_comparison(self):
        if not self.engineering_mode:
            return
        comp_fields = {
            'mac': self.comparison_fields.get('compare_mac', True),
            'oui': self.comparison_fields.get('compare_oui', True),
            'vendor': self.comparison_fields.get('compare_vendor', False),
            'model': self.comparison_fields.get('compare_model', False),
            'ip': self.comparison_fields.get('compare_ip', False),
            'address': self.comparison_fields.get('compare_address', False),
            'room': self.comparison_fields.get('compare_room', False),
            'switch_ip': self.comparison_fields.get('compare_switch_ip', False),
            'switch_port': self.comparison_fields.get('compare_switch_port', False)
        }
        self.enricher.set_comparison_fields(comp_fields, self.comparison_fields.get('threshold', 70))
        self.enricher.set_enrich_fields(self.enrich_fields)
        
        dialog = FileComparisonDialog(self.enricher, self.analyzer, self.oui_formats, self)
        dialog.exec_()
    
    def open_multi_file_comparison(self):
        if not self.engineering_mode:
            return
        dialog = MultiFileComparisonDialog(self.analyzer, self)
        dialog.exec_()
    
    def show_timestats(self):
        if not self.engineering_mode:
            return
        dialog = TimeStatsDialog(self.stats_db, self)
        dialog.exec_()
    
    def show_notification_settings(self):
        if not self.engineering_mode:
            return
        dialog = NotificationSettingsDialog(self.notification_service, self)
        dialog.exec_()
    
    def show_scheduler(self):
        if not self.engineering_mode:
            return
        dialog = SchedulerDialog(self.scheduler, self)
        dialog.exec_()
    
    def single_file_analysis(self):
        if not self.engineering_mode:
            return
        dialog = SingleFileAnalysisDialog(self)
        dialog.exec_()
    
    def start_enrichment(self):
        if not self.engineering_mode:
            return
        if not self.enricher.primary_alias:
            QMessageBox.warning(self, "Ошибка", "Выберите основной файл!")
            return
        if len(self.enricher.files) < 2:
            QMessageBox.warning(self, "Ошибка", "Добавьте дополнительные файлы!")
            return
        
        self.row_strategy = "add_new_rows" if self.strategy_add_new.isChecked() else "keep_primary_only"
        
        comp_fields = {
            'mac': self.comparison_fields.get('compare_mac', True),
            'oui': self.comparison_fields.get('compare_oui', True),
            'vendor': self.comparison_fields.get('compare_vendor', False),
            'model': self.comparison_fields.get('compare_model', False),
            'ip': self.comparison_fields.get('compare_ip', False),
            'address': self.comparison_fields.get('compare_address', False),
            'room': self.comparison_fields.get('compare_room', False),
            'switch_ip': self.comparison_fields.get('compare_switch_ip', False),
            'switch_port': self.comparison_fields.get('compare_switch_port', False)
        }
        
        self.enricher.set_comparison_fields(comp_fields, self.comparison_fields.get('threshold', 70))
        self.enricher.set_enrich_fields(self.enrich_fields)
        self.enricher.set_oui_formats(self.oui_formats)
        
        self.enricher.auto_detect_ip_address_mapping()
        
        self.progress_dialog = QProgressDialog("Подготовка к обогащению...", "Отмена", 0, 100, self)
        self.progress_dialog.setWindowModality(Qt.WindowModal)
        self.progress_dialog.setMinimumDuration(0)
        self.progress_dialog.setAutoClose(False)
        self.progress_dialog.canceled.connect(self.cancel_enrichment)
        self.progress_dialog.show()
        
        start_time = time.time()
        
        self.worker = EnrichmentWorker(self.enricher, self.analyzer, 0, self.row_strategy)
        self.worker.progress.connect(self.progress_dialog.setValue)
        self.worker.status.connect(lambda s: self.progress_dialog.setLabelText(s))
        self.worker.finished.connect(lambda devices: self.on_finished(devices, start_time))
        self.worker.error.connect(self.on_error)
        self.worker.start()
        
        QApplication.processEvents()
    
    def on_finished(self, devices, start_time):
        processing_time = time.time() - start_time
        self.current_devices = devices
        
        self.export_btn.setEnabled(True)
        self.analytics_btn.setEnabled(True)
        
        if self.progress_dialog:
            self.progress_dialog.close()
            self.progress_dialog = None
        
        self.display_results(devices)
        self.display_stats(devices)
        
        if self.chart_widget:
            self.chart_widget.update_charts(devices)
        if self.topology_widget:
            self.topology_widget.update_topology(devices)
        
        filename = self.main_file_edit.text()
        
        added_vendors, added_models = self.enricher.save_scan_to_history(devices, filename)
        logging.info(f"Сохранено в историю: производителей={added_vendors}, моделей={added_models}")
        
        self.stats_db.save_snapshot(devices, filename, self.row_strategy, processing_time)
        self.stats_db.save_performance_metric("enrichment", processing_time, f"{len(devices)} devices")
        self.notification_service.on_analysis_complete(devices, Path(filename).name if filename else "Анализ", processing_time)
        
        has_address = len([d for d in devices if d.get('address') and d['address'] not in ['Unknown', None, '']])
        has_room = len([d for d in devices if d.get('room') and d['room'] not in ['Unknown', 'Не указано', None, '']])
        has_switch = len([d for d in devices if d.get('switch_ip') and d['switch_ip'] not in ['Unknown', None, '']])
        custom_count = sum(len(dev.get('custom_fields', {})) for dev in devices)
        self.status_bar.update_stats(len(devices), has_address, has_room, custom_count, has_switch)
        
        ip_stats = self.enricher.get_ip_mapping_stats()
        vendor_stats = self.enricher.get_vendor_detector_stats()
        history_stats = self.enricher.get_history_stats()
        
        QMessageBox.information(self, "Готово", 
            f"Обработка завершена!\n"
            f"Всего устройств: {len(devices)}\n"
            f"Время обработки: {processing_time:.2f} сек.\n\n"
            f"🏭 ОПРЕДЕЛЕНИЕ ПРОИЗВОДИТЕЛЕЙ И МОДЕЛЕЙ:\n"
            f"  • OUI (3 байта MAC): {'Вкл' if vendor_stats.get('use_oui_3byte', True) else 'Выкл'}\n"
            f"  • MAC5 (5 байт MAC): {'Вкл' if vendor_stats.get('use_oui_5byte', True) else 'Выкл'}\n"
            f"  • Анализ текста: {'Вкл' if vendor_stats.get('use_text_analysis', True) else 'Выкл'}\n"
            f"  • Инференс: {'Вкл' if vendor_stats.get('use_inference', True) else 'Выкл'}\n\n"
            f"🏠 СООТВЕТСТВИЯ IP→АДРЕС:\n"
            f"  • Всего соответствий: {ip_stats['total_mappings']}\n"
            f"  • Частичное совпадение: {'Вкл' if ip_stats.get('partial_match_enabled', True) else 'Выкл'}\n\n"
            f"📚 ИСТОРИЯ ПРОИЗВОДИТЕЛЕЙ И МОДЕЛЕЙ:\n"
            f"  • Загружено файлов: {history_stats.get('total_loads', 0)}\n"
            f"  • Уникальных OUI: {history_stats.get('total_oui_vendor', 0)}\n"
            f"  • Уникальных префиксов: {history_stats.get('total_mac5_model', 0)}\n"
            f"  • Уникальных производителей: {history_stats.get('unique_vendors', 0)}\n\n"
            f"💡 Совет: Используйте кнопку 'Экспорт результатов' для сохранения данных в 7+ форматах\n"
            f"💡 Совет: Используйте кнопку 'Аналитика' для получения статистики по всем устройствам\n"
            f"💡 Совет: Используйте кнопку 'История изменений' для отслеживания изменений по датам")
        
        self.status_bar.showMessage(f"Готово. Обработано {len(devices)} устройств за {processing_time:.2f} сек")
        self.show_results()
    
    def on_error(self, msg):
        if self.progress_dialog:
            self.progress_dialog.close()
            self.progress_dialog = None
        QMessageBox.critical(self, "Ошибка", msg)
        self.logger.log_error("Ошибка обогащения", msg)
    
    def display_results(self, devices):
        if not devices:
            self.results_table.setRowCount(0)
            self.results_table.setColumnCount(0)
            return
        
        self.results_table.setUpdatesEnabled(False)
        try:
            visible_columns = self.column_manager.get_visible_columns()
            self.results_table.setColumnCount(len(visible_columns))
            self.results_table.setHorizontalHeaderLabels(visible_columns)
            self.results_table.setRowCount(len(devices))
            
            for i, dev in enumerate(devices):
                for j, col_name in enumerate(visible_columns):
                    value = self.column_manager.get_column_value(dev, col_name, i)
                    self.results_table.setItem(i, j, QTableWidgetItem(str(value)))
                if i % 500 == 0:
                    QApplication.processEvents()
        finally:
            self.results_table.setUpdatesEnabled(True)
        
        self.results_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
    
    def display_stats(self, devices):
        total = len(devices)
        if total == 0:
            return
        
        with_address = len([d for d in devices if d.get('address') and d['address'] not in ['Unknown', None, '']])
        with_room = len([d for d in devices if d.get('room') and d['room'] not in ['Unknown', 'Не указано', None, '']])
        with_model = len([d for d in devices if d.get('model') and d['model'] not in ['Unknown', None, '']])
        with_switch = len([d for d in devices if d.get('switch_ip') and d['switch_ip'] not in ['Unknown', None, '']])
        vendors = len(set([d.get('vendor') for d in devices if d.get('vendor') and d['vendor'] != 'Unknown']))
        
        self.status_bar.showMessage(f"Всего устройств: {total}, Производителей: {vendors}, Адресов: {with_address}, Помещений: {with_room}, Коммутаторов: {with_switch}")
    
    def save_results(self):
        if not self.engineering_mode:
            return
        if not self.current_devices:
            QMessageBox.warning(self, "Ошибка", "Нет данных для сохранения!")
            return
        
        menu = QMenu(self)
        menu.addAction("Excel (.xlsx)").triggered.connect(lambda: self._save_to_format('xlsx'))
        menu.addAction("CSV (.csv)").triggered.connect(lambda: self._save_to_format('csv'))
        menu.addAction("TXT (.txt)").triggered.connect(lambda: self._save_to_format('txt'))
        menu.addAction("HTML (.html)").triggered.connect(lambda: self._save_to_format('html'))
        menu.addAction("JSON (.json)").triggered.connect(lambda: self._save_to_format('json'))
        if YAML_AVAILABLE:
            menu.addAction("YAML (.yaml)").triggered.connect(lambda: self._save_to_format('yaml'))
        if PDF_AVAILABLE:
            menu.addAction("PDF (.pdf)").triggered.connect(lambda: self._save_to_format('pdf'))
        menu.exec_(self.cursor().pos())
    
    def _save_to_format(self, format_type):
        if not self.current_devices:
            return
        default_name = f"mac_analyzer_results_{datetime.now().strftime('%Y%m%d_%H%M%S')}.{format_type}"
        filename, _ = QFileDialog.getSaveFileName(self, "Сохранить результаты", default_name, f"{format_type.upper()} Files (*.{format_type})")
        if filename:
            start_time = time.time()
            success = False
            if format_type == 'xlsx':
                success = ExportManager.export_to_excel(filename, self.current_devices, self.column_manager)
            elif format_type == 'csv':
                success = ExportManager.export_to_csv(filename, self.current_devices, self.column_manager)
            elif format_type == 'txt':
                success = ExportManager.export_to_txt(self.current_devices, filename, self.column_manager)
            elif format_type == 'html':
                success = ExportManager.export_to_html(filename, self.current_devices, self.column_manager)
            elif format_type == 'json':
                success = ExportManager.export_to_json(filename, self.current_devices, self.column_manager)
            elif format_type == 'yaml' and YAML_AVAILABLE:
                success = ExportManager.export_to_yaml(filename, self.current_devices, self.column_manager)
            elif format_type == 'pdf' and PDF_AVAILABLE:
                success = ExportManager.export_to_pdf_chunked(filename, self.current_devices, self.column_manager)
            if success:
                elapsed = time.time() - start_time
                self.stats_db.save_performance_metric(f"export_{format_type}", elapsed, f"{len(self.current_devices)} devices")
                QMessageBox.information(self, "Успех", f"Результаты сохранены в {filename}\nВремя экспорта: {elapsed:.2f} сек.")
                self.logger.log_action("Экспорт результатов", filename)
            else:
                QMessageBox.warning(self, "Ошибка", f"Не удалось сохранить результаты в {format_type.upper()}")
    
    def clear_results(self):
        if not self.engineering_mode:
            return
        self.results_table.setRowCount(0)
        self.results_table.setColumnCount(0)
        self.current_devices = []
        self.export_btn.setEnabled(False)
        self.analytics_btn.setEnabled(False)
        self.status_bar.update_stats(0, 0, 0)
        self.status_bar.showMessage("Результаты очищены")
        self.logger.log_action("Очистка результатов", "")
    
    def run_scheduled_analysis(self, files):
        if not self.engineering_mode:
            return
        self.enricher = DataEnricher()
        for f in files:
            self.main_file_edit.setText(f)
            self.enricher.add_file(f, Path(f).stem, True)
            self.start_enrichment()
    
    def help_system(self):
        help_text = """
        MAC Analyzer Pro Full Edition v9.0 - Справка
        
        🔐 ДВА РЕЖИМА РАБОТЫ:
        
        👤 ПОЛЬЗОВАТЕЛЬСКИЙ РЕЖИМ (по умолчанию):
        - Поиск по истории MAC-адресов, производителей и моделей
        - Отображается полная информация: MAC, производитель, модель, IP, адрес, помещение, IP коммутатора, порт
        - Двойной клик по MAC-адресу показывает полную историю или аналитику устройства
        - Двойной клик по модели показывает все префиксы MAC для этой модели
        - Доступна аналитика по всем устройствам и экспорт результатов
        - Доступна история изменений по датам
        
        🔧 ИНЖЕНЕРНЫЙ РЕЖИМ:
        - Доступен после нажатия на название программы и ввода пароля (admin123)
        - Кнопка выхода в пользовательский режим
        - Полный функционал программы (обогащение, сравнение, настройки, API, графики)
        - Подсветка активной кнопки навигации
        
        📎 ЭКСПОРТ РЕЗУЛЬТАТОВ (доступен в обоих режимах при наличии данных):
        - Excel (.xlsx) - полный экспорт всех данных с настройками колонок
        - CSV (.csv) - экспорт для импорта в другие системы
        - TXT (.txt) - текстовый отчет
        - HTML (.html) - веб-отчет
        - JSON (.json) - для программистов
        - YAML (.yaml) - альтернативный формат
        - PDF (.pdf) - профессиональный отчет
        
        📊 АНАЛИТИКА (доступна в обоих режимах):
        - Общая статистика по всем устройствам
        - Распределение по производителям, моделям, помещениям, коммутаторам
        - Заполненность полей
        - Экспорт аналитики в Excel
        
        📅 ИСТОРИЯ ИЗМЕНЕНИЙ ПО ДАТАМ (доступна в обоих режимах):
        - Просмотр всех изменений за выбранный период
        - Фильтрация по датам (начальная и конечная дата)
        - Статистика изменений по дням
        - Топ наиболее изменяемых MAC-адресов
        - Экспорт истории изменений в Excel
        - Двойной клик по изменению для просмотра полной истории MAC
        
        📚 ИСТОРИЯ MAC-АДРЕСОВ:
        - Автоматическое сохранение всех появлений каждого MAC-адреса
        - Отслеживание изменений (перемещения по сети, смена IP, адреса, помещения)
        - Детальная хронология появления устройства в разных файлах
        - Статистика по каждому MAC-адресу
        
        📱 ПОИСК ПО МОДЕЛЯМ:
        - Двойной клик по модели показывает все префиксы 5 байт MAC для этой модели
        - Отображается количество вхождений каждого префикса
        
        🎨 ПОДСВЕТКА КНОПОК:
        - Текущий раздел выделяется цветом для удобной навигации
        
        ПОЛНЫЙ ФУНКЦИОНАЛ (в инженерном режиме):
        
        1. ОБОГАЩЕНИЕ ДАННЫХ
           - MAC-адрес → производитель (по OUI)
           - MAC-адрес → модель (по префиксу 5 байт)
           - IP коммутатора → физический адрес
           - Извлечение из текстовых полей
           - Инференс из похожих устройств
           - ИСТОРИЧЕСКОЕ ОБОГАЩЕНИЕ
           - ⚠️ Данные из файла имеют приоритет и не перезаписываются
        
        2. НАСТРОЙКИ:
           - 🏭 Определение производителя и модели
           - 🏠 IP коммутатора → Адрес
           - 📚 Историческое обогащение
           - Форматы OUI
           - Оповещения
           - Планировщик задач
        
        3. СРАВНЕНИЕ ФАЙЛОВ
           - Двух файлов с детальным отчетом
           - Нескольких файлов (до 10)
        
        4. УПРАВЛЕНИЕ КОЛОНКАМИ
           - Выбор отображаемых колонок
           - Пользовательские колонки
        
        5. СТАТИСТИКА И ГРАФИКИ
           - Динамика изменений
           - Топология сети
        
        ФОРМАТЫ ЭКСПОРТА:
        Excel, CSV, TXT, HTML, JSON, YAML, PDF
        
        ГОРЯЧИЕ КЛАВИШИ:
        Ctrl+O - открыть файл
        Ctrl+S - сохранить результаты
        Ctrl+E - экспорт результатов
        Ctrl+A - аналитика
        Ctrl+H - история изменений
        F5 - запустить обогащение
        F6 - сравнение двух файлов
        F7 - графики
        F8 - топология сети
        F9 - сравнение нескольких файлов
        F1 - справка
        Ctrl+F - поиск
        Esc - отмена
        """
        QMessageBox.information(self, "Справка", help_text)


# ==================== ЗАПУСК ====================

def main():
    app = QApplication(sys.argv)
    app.setStyle('Fusion')
    
    splash = QSplashScreen()
    splash_pix = QPixmap(950, 1080)
    splash_pix.fill(Qt.white)
    p = QPainter(splash_pix)
    p.setPen(QPen(QColor(100, 100, 100), 2))
    p.setFont(QFont("Segoe UI", 28, QFont.Bold))
    p.drawText(50, 100, "MAC Analyzer Pro")
    p.setFont(QFont("Segoe UI", 14))
    p.drawText(50, 170, "Full Edition 9.0")
    p.setFont(QFont("Segoe UI", 11))
    p.drawText(50, 220, "🔐 ДВА РЕЖИМА РАБОТЫ:")
    p.drawText(70, 255, "👤 ПОЛЬЗОВАТЕЛЬСКИЙ: поиск по БД и история устройств")
    p.drawText(70, 290, "🔧 ИНЖЕНЕРНЫЙ: полный функционал (клик на название + пароль)")
    p.drawText(70, 325, "🔓 Выход из инженерного режима - кнопка")
    p.drawText(50, 375, "📎 ЭКСПОРТ РЕЗУЛЬТАТОВ (7+ форматов)")
    p.drawText(50, 425, "📊 АНАЛИТИКА по всем устройствам")
    p.drawText(50, 475, "📅 ИСТОРИЯ ИЗМЕНЕНИЙ ПО ДАТАМ")
    p.drawText(70, 510, "✅ Выбор периода (начальная и конечная дата)")
    p.drawText(70, 545, "✅ Статистика изменений по дням")
    p.drawText(70, 580, "✅ Топ наиболее изменяемых MAC-адресов")
    p.drawText(70, 615, "✅ Экспорт истории в Excel")
    p.drawText(50, 665, "📚 ИСТОРИЯ MAC-АДРЕСОВ:")
    p.drawText(70, 700, "✅ Полная хронология каждого устройства")
    p.drawText(70, 735, "✅ Отслеживание перемещений по сети")
    p.drawText(70, 770, "✅ Двойной клик по MAC для просмотра истории/аналитики")
    p.drawText(70, 805, "✅ Статистика по каждому MAC-адресу")
    p.drawText(50, 855, "📱 ПОИСК ПО МОДЕЛЯМ:")
    p.drawText(70, 890, "✅ Двойной клик показывает все префиксы MAC для модели")
    p.drawText(50, 940, "📊 ПОЛНАЯ ИНФОРМАЦИЯ В ПОИСКЕ:")
    p.drawText(70, 975, "✅ MAC-адрес, производитель, модель")
    p.drawText(70, 1010, "✅ IP-адрес, физический адрес, помещение")
    p.drawText(70, 1045, "✅ IP коммутатора, порт подключения")
    p.drawText(50, 1095, "🎨 ПОДСВЕТКА АКТИВНОЙ КНОПКИ")
    p.drawText(50, 1145, "✅ API интеграция (3 сервиса)")
    p.drawText(50, 1195, "✅ Топология сети и графики")
    p.drawText(50, 1245, "✅ Полная документация (F1)")
    p.end()
    splash.setPixmap(splash_pix)
    splash.show()
    app.processEvents()
    
    time.sleep(2)
    
    window = MainWindow()
    window.show()
    splash.finish(window)
    
    sys.exit(app.exec_())


if __name__ == "__main__":
    main()