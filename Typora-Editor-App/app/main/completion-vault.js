'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {app, safeStorage} = require('electron');
class CompletionVault {
  constructor({file=path.join(app.getPath('userData'),'completion-secrets.json'), crypto=safeStorage}={}) {
    this.file=file;this.crypto=crypto;this.pending=Promise.resolve();this.data={};
    this.ready=fs.readFile(file,'utf8').then(raw=>{this.data=JSON.parse(raw);},error=>{if(error.code!=='ENOENT')throw error;});
  }
  available() {
    if(!this.crypto.isEncryptionAvailable())throw new Error('系统加密存储暂不可用，请重新启动后再保存 API Key。');
  }
  async get(id) {
    await this.ready;await this.pending;
    const value=this.data[id];if(!value)return undefined;
    // v2.0.9:解密失败或系统加密暂不可用时按"无此密钥"处理——密文可能来自
    // 应用身份/数据目录变更前的旧实例（如重命名迁移），保险库读失败绝不
    // 允许炸掉补全引导乃至文档打开（用户实测 2.0.8 打开文档全空白）。
    try {
      this.available();
      return this.crypto.decryptString(Buffer.from(value,'base64'));
    } catch (error) {
      console.error('completion vault: stored key unreadable, treating as absent:', error.message);
      return undefined;
    }
  }
  write(change) {
    const operation=this.pending.then(async()=>{
      await this.ready;const next={...this.data};change(next);
      await fs.mkdir(path.dirname(this.file),{recursive:true});
      const temporary=this.file+'.tmp';await fs.writeFile(temporary,JSON.stringify(next),{mode:0o600});await fs.rename(temporary,this.file);this.data=next;
    });
    this.pending=operation.catch(()=>{});return operation;
  }
  store(id,value) {return this.write(next=>{this.available();next[id]=this.crypto.encryptString(value).toString('base64');});}
  delete(id) {return this.write(next=>{delete next[id];});}
}
module.exports={CompletionVault};
