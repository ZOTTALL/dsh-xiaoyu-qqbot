import {resolvePaths} from '../lib/config.mjs'
import {installTemplates} from '../lib/bridge-install.mjs'
const p=resolvePaths()
console.log(JSON.stringify(installTemplates({workspace:p.workspace})))
