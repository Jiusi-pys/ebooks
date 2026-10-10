package org.shufang.android

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalLayoutApi::class)
@Composable fun AiScreen(model:LibraryViewModel,state:LibraryState) {
    var question by rememberSaveable {mutableStateOf("")}
    val modelPicker=androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.OpenDocument()){uri->uri?.let {model.installLocalModel(it)}}
    var language by rememberSaveable {mutableStateOf("中文")}
    LazyColumn(Modifier.fillMaxSize().imePadding(),contentPadding=PaddingValues(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
        item {
            Text(state.book?.text("title")?:"AI 阅读助手",style=MaterialTheme.typography.titleLarge)
            state.selection?.let {Text("选文：${it.optString("text").take(300)}")}
            Text(state.localAiStatus)
            Text(state.aiSource)
            Row {TextButton(onClick={modelPicker.launch(arrayOf("application/octet-stream","*/*"))}){Text("安装离线模型")};TextButton(onClick=model::removeLocalModel){Text("移除模型")}}
            val config=state.aiConfig.optJSONObject("value")
            Text("${config?.optString("provider").orEmpty()} · ${config?.optString("model").orEmpty()}")
            Row {TextButton(onClick={model.navigate("settings")}){Text("配置 AI")};state.book?.let {book->TextButton(onClick={model.openBook(book.id)}){Text("返回阅读")}}}
            OutlinedTextField(question,{question=it},label={Text("问题 / 生成要求")},modifier=Modifier.fillMaxWidth(),minLines=3)
            OutlinedTextField(language,{language=it},label={Text("翻译目标语言")},modifier=Modifier.fillMaxWidth())
            OutlinedButton(onClick={model.askLocal(question)}){Text("设备端问答")}
            FlowRow {for((task,label)in listOf("chat" to "对话","translate" to "翻译","studyCard" to "制卡","mindMap" to "生成脑图","digest" to "全书导读"))OutlinedButton(onClick={model.ai(task,question,language)}){Text(label)}}
            Row {TextButton(onClick=model::cancelAi){Text("取消 AI 等待")};TextButton(onClick=model::clearConversation){Text("新建对话")}}
            if(state.aiMindTarget!=null)Text("生成结果将追加到《${state.aiMindTarget.text("title")}》的当前章节")
        }
        val messages=state.aiMessages
        if(state.aiTask=="chat")items(messages.length()) {index->val message=messages.getJSONObject(index)
            Card(Modifier.fillMaxWidth()) {Column(Modifier.padding(12.dp)){Text(if(message.optString("role")=="user")"提问"else "回答",style=MaterialTheme.typography.labelMedium);SelectionContainer {Text(message.optString("content"))}}}
        }
        else if(state.aiResult.isNotEmpty())item {SelectionContainer {Text(state.aiResult)}}
        if(state.aiResult.isNotEmpty())item {
            Button(onClick=model::saveAi){Text("保存到书库")}
            if(state.aiTask=="chat"&&state.selection!=null)TextButton(onClick=model::saveQa){Text("保存问答到文段")}
        }
    }
}
