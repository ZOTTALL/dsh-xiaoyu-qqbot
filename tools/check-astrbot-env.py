"""No-network dependency consistency check before reporting AstrBot deployment done."""
import importlib.metadata as metadata
import json
import platform
from pathlib import Path
import sys
from packaging.requirements import Requirement
from packaging.specifiers import SpecifierSet

project=Path(sys.argv[1])/'pyproject.toml'
dependencies=['quart','aiohttp','loguru','openai']
python_ok=True
if project.exists():
    try:
        import tomllib
    except ImportError:
        import tomli as tomllib
    config=tomllib.loads(project.read_text('utf-8'))['project']
    dependencies=config.get('dependencies',dependencies)
    python_ok=SpecifierSet(config.get('requires-python','')).contains(platform.python_version())
missing=[]
for entry in dependencies:
    requirement=Requirement(entry)
    if requirement.marker and not requirement.marker.evaluate():continue
    try:
        version=metadata.version(requirement.name)
        if requirement.specifier and not requirement.specifier.contains(version,prereleases=True):missing.append(requirement.name)
    except metadata.PackageNotFoundError:missing.append(requirement.name)
ok=python_ok and not missing
print(json.dumps({'ok':ok,'python':platform.python_version(),'requirementsChecked':len(dependencies),'missingOrIncompatible':missing},ensure_ascii=False))
sys.exit(0 if ok else 1)
