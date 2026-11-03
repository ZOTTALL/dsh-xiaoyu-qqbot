// Fictional, deterministic screenshot fixture. Never reads a live installation.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {installTemplates} from '../lib/bridge-install.mjs'
const root=path.resolve(process.argv[2]||fs.mkdtempSync(path.join(os.tmpdir(),'qqbot-demo-')))
fs.mkdirSync(root,{recursive:true})
if(fs.readdirSync(root).length)throw new Error('演示目录必须为空，避免覆盖任何现有数据')
const workspace=path.join(root,'workspace');installTemplates({workspace})
const texts=[
  '主人偏好简洁的任务汇报；重要结论附来源。','机器人学习了新的 Python 算法，完成数学建模和数据实验。',
  '下周计划整理摄影作品，并为艺术展制作配色方案。','部署语音服务之前先检查环境、模型和参考音频。',
  '讨论计划时先确定目标，再对不同策略作推理和决策。','知识库整理了语言表达、接口设计与工具使用说明。',
  '视觉创作包含摄影、绘画、动画设计和音乐审美。','记录共同经历时保留日期与证据，不推断未发生的事情。',
  '执行部署脚本后检查服务状态，最后写入备份日志。','计算模型使用数据验证，算法结果与原始实验保留关联。',
  '主人约定每周回顾一次计划，机器人核对尚未完成的任务。','语言表达应自然清楚，知识与推测分别标注。',
  '摄影实验比较不同配色，艺术展计划选择暖色主题。','技能练习包含安装、启动、调试和修复服务。',
  '记忆系统保留原文证据，偏好更新保留来源。','任务规划涉及计算模型、视觉设计和语言汇报。',
  '数据实验结束后执行整理脚本，再按计划制作动画图表。','工具知识帮助部署服务，执行结果回写经历记录。'
]
fs.writeFileSync(path.join(workspace,'memory','facts.md'),'# 虚构演示事实\n\n'+texts.map(x=>'- '+x).join('\n\n')+'\n')
const cfg={root,ownerQq:'',botQq:'',ports:{napcatHttp:19302,napcatWebui:19399,astrbotUi:19185,astrbotWs:19199,ingress:19188,tts:19880},watchdog:{enabled:false},autostart:{napcat:false,astrbot:false,tts:false}}
const file=path.join(root,'demo.config.json');fs.writeFileSync(file,JSON.stringify(cfg,null,2))
console.log(file)
