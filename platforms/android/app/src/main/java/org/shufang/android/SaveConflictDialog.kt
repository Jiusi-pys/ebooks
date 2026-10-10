package org.shufang.android

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable fun SaveConflictDialog(model:LibraryViewModel,state:LibraryState) {
    state.saveConflict?.let {conflict->AlertDialog(onDismissRequest=model::dismissSaveConflict,title={Text("资料已被其他操作修改")},text={Column(Modifier.heightIn(max=400.dp).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(8.dp)) {
        Text("草稿已保留。请选择如何处理，本次选择将再次核验当前版本。")
        for(key in conflict.patch.keys())if(key !in listOf("createdAt","updatedAt")){
            Text(key,style=MaterialTheme.typography.titleSmall)
            SelectionContainer {Text("当前：${conflict.current.value.opt(key).toString().take(1200)}\n草稿：${conflict.patch.opt(key).toString().take(1200)}")}
        }
        if(conflict.kind in listOf("notes","highlights","translations","mindMaps","studySets"))TextButton(onClick={model.resolveSaveConflict("copy")},enabled=state.busy.isEmpty()){Text("保留双方副本")}
        TextButton(onClick={model.resolveSaveConflict("remote")},enabled=state.busy.isEmpty()){Text("保留当前版本")}
    }},confirmButton={TextButton(onClick={model.resolveSaveConflict("local")},enabled=state.busy.isEmpty()){Text("保存我的修改")}},dismissButton={TextButton(onClick=model::dismissSaveConflict){Text("稍后处理")}})}
}
