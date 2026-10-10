package org.shufang.android

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalLayoutApi::class)
@Composable fun StudyBackupPanel(model:LibraryViewModel,state:LibraryState) {
    var set by rememberSaveable {mutableStateOf<String?>(null)}
    var policy by rememberSaveable {mutableStateOf("keepLocal")}
    val export=rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/zip")){uri->uri?.let {model.exportStudy(it,set)}}
    val restore=rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()){uri->uri?.let {model.previewStudy(it,policy)}}
    Text("学习备份与恢复",style=MaterialTheme.typography.titleLarge)
    FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
        FilterChip(set==null,{set=null},label={Text("全部资料")})
        for(record in state.records["studySets"].orEmpty())FilterChip(set==record.id,{set=record.id},label={Text(record.text("name"))})
    }
    OutlinedButton(onClick={export.launch("ShufangStudyBackup.zip")},enabled=state.busy.isEmpty()){Text("导出学习包")}
    Text("恢复策略")
    FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)){for((id,label)in listOf("keepLocal" to "保留本机","keepBoth" to "双方副本","replace" to "备份版本"))FilterChip(policy==id,{policy=id},label={Text(label)})}
    OutlinedButton(onClick={restore.launch(arrayOf("application/zip","application/octet-stream"))},enabled=state.busy.isEmpty()){Text("选择备份并预览")}
    state.studyRestorePreview?.let {preview->AlertDialog(onDismissRequest={if(state.busy.isEmpty())model.cancelStudyRestore()},title={Text("恢复预览 · ${preview.optString("title")}")},text={Column(Modifier.heightIn(max=400.dp).verticalScroll(rememberScrollState())) {
        Text("策略："+mapOf("keepLocal" to "保留本机","keepBoth" to "双方副本","replace" to "备份版本")[preview.optString("policy")])
        val counts=preview.getJSONObject("counts");val names=mapOf("books" to "书籍","sources" to "原文件","notes" to "笔记","highlights" to "学习卡片","folders" to "文件夹","mindMaps" to "脑图","studySets" to "学习集","associations" to "关联","reviews" to "复习记录","translations" to "译文");for(kind in counts.keys())Text("${names[kind]?:kind}：${counts.getInt(kind)} 项")
        Text("重建身份 ${preview.optInt("mapped")} 项。确认后先保存原书库备份，再整体提交。预览后资料变化将要求重新预览。")
    }},confirmButton={TextButton(onClick=model::commitStudyRestore,enabled=state.busy.isEmpty()){Text("确认恢复")}},dismissButton={TextButton(onClick=model::cancelStudyRestore,enabled=state.busy.isEmpty()){Text("取消")}})}
}
