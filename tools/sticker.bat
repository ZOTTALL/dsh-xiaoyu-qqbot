@echo off
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
if defined QQBOT_ASTRBOT_PY (
  "%QQBOT_ASTRBOT_PY%" -X utf8 -S "%~dp0sticker.py" %*
) else (
  python -X utf8 -S "%~dp0sticker.py" %*
)
