@echo off
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
rem 优先用「设置」里配置的 AstrBot 虚拟环境 Python；没配就退回系统 python。
rem QQBOT_ASTRBOT_PY 可手动导出覆盖，面板一键部署后会提示正确路径。
if defined QQBOT_ASTRBOT_PY (
  "%QQBOT_ASTRBOT_PY%" -X utf8 "%~dp0voice.py" %*
) else (
  python -X utf8 "%~dp0voice.py" %*
)
