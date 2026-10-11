// Test-only preservation of all formats exposed by Electron, including an
// empty Windows clipboard represented as a ClipboardItem with no MIME types.
const assert=require('node:assert/strict');
exports.preserveClipboard=async()=>{
  const {clipboard,ClipboardItem}=require('electron'),saved=[];
  for(const item of await clipboard.read()){
    if(!item.types.length)continue;
    const data={};for(const type of item.types)data[type]=await item.getType(type);
    saved.push(new ClipboardItem(data));
  }
  const text=String(await clipboard.readText()??'');
  return async()=>{
    if(saved.length)await clipboard.write(saved);else clipboard.clear();
    assert.equal(String(await clipboard.readText()??''),text,'original clipboard text restored');
  };
};
