package org.shufang.android

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.*
import androidx.compose.foundation.Image
import androidx.compose.ui.graphics.asImageBitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.json.JSONObject

private val conflictKinds=mapOf("books" to "书籍","notes" to "笔记","highlights" to "学习卡片","mindMaps" to "脑图","studySets" to "学习集","translations" to "译文","folders" to "文件夹","associations" to "关联")

@Composable fun SyncConflictPanel(model:LibraryViewModel,state:LibraryState) {
    if(state.syncConflicts.isEmpty())return
    Text("离线同步冲突 · ${state.syncConflicts.size}",style=MaterialTheme.typography.titleLarge)
    Text("双方版本已保留。请逐项选择，再继续同步。关闭或重启不会丢失未处理的冲突。")
    state.syncConflicts.forEachIndexed {index,row->OutlinedButton(onClick={model.previewSyncConflict(row.getString("id"))},enabled=state.busy.isEmpty(),modifier=Modifier.fillMaxWidth()) {Text("查看${conflictKinds[row.optString("kind")]?:"资料"}冲突 ${index+1}")}}
}

@Composable private fun ConflictVersion(label:String,value:JSONObject?,deleted:Boolean) {
    Text(label,style=MaterialTheme.typography.titleMedium)
    if(deleted||value==null){Text("此版本已删除或不存在");return}
    val path=value.optString("_inkPreviewPath")
    val bitmap by produceState<android.graphics.Bitmap?>(null,path){if(path.isNotEmpty())this.value=withContext(Dispatchers.IO){val options=android.graphics.BitmapFactory.Options().apply {inJustDecodeBounds=true};android.graphics.BitmapFactory.decodeFile(path,options);if(options.outWidth !in 1..8192||options.outHeight !in 1..8192)null else {options.inJustDecodeBounds=false;options.inSampleSize=maxOf(1,maxOf(options.outWidth,options.outHeight)/1200);android.graphics.BitmapFactory.decodeFile(path,options)}}}
    bitmap?.let {Image(it.asImageBitmap(),"$label · 手写预览",Modifier.fillMaxWidth().heightIn(max=240.dp))}
    if(value.has("pdfPortableInk"))Text("此版本含可编辑手写附件，选择时完整保留笔画。")
    val names=mapOf("title" to "标题","name" to "名称","content" to "正文","text" to "原文","note" to "批注","question" to "问题","answer" to "答案","color" to "颜色","tags" to "标签")
    for((key,name)in names)if(value.has(key)&&!value.isNull(key)){Text(name,style=MaterialTheme.typography.labelLarge);val text=value.opt(key)?.toString().orEmpty();Text(text.take(12000));if(text.length>12000)Text("界面显示前 12000 字，完整内容仍保留。")}
    if(names.keys.none {value.has(it)})Text("此资料包含结构化内容，请保留双方副本后继续整理。")
}

@OptIn(ExperimentalLayoutApi::class)
@Composable fun SyncConflictDialog(model:LibraryViewModel,state:LibraryState) {
    val preview=state.syncConflictPreview?:return
    val busy=state.busy.isNotEmpty()
    val canCopy=preview.optString("kind") in listOf("books","folders","notes","highlights","mindMaps","studySets","translations")&&!preview.getJSONObject("localState").optBoolean("deleted")
    AlertDialog(onDismissRequest={if(!busy)model.dismissSyncConflict()},title={Text("选择要保留的版本")},text={Column(Modifier.heightIn(max=440.dp).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(12.dp)) {
        if(preview.optBoolean("legacy"))Text("这次修改来自旧版本，缺少编辑基线，请核对双方内容。")
        ConflictVersion("本机离线版本",preview.optJSONObject("local"),preview.getJSONObject("localState").optBoolean("deleted"))
        HorizontalDivider()
        ConflictVersion("服务器版本",preview.optJSONObject("remote"),preview.optJSONObject("remoteState")?.optBoolean("deleted")?:true)
        if(preview.optString("kind") in listOf("books","folders"))Text("保留双方或保留已被服务器删除的本机版本，会复制容器及其关联学习资料，并重建引用。")
        Text("选择本机将提交新的修改；服务器已删除时会另存副本。选择服务器将放弃这次尚未发送的本机修改。")
    }},confirmButton={FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
        TextButton(onClick={model.resolveSyncConflict("remote")},enabled=!busy){Text("保留服务器")}
        TextButton(onClick={model.resolveSyncConflict("local")},enabled=!busy){Text("保留本机")}
        if(canCopy)TextButton(onClick={model.resolveSyncConflict("copy")},enabled=!busy){Text("保留双方副本")}
    }},dismissButton={TextButton(onClick=model::dismissSyncConflict,enabled=!busy){Text("稍后处理")}})
}
