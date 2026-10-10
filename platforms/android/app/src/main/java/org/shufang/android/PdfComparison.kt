package org.shufang.android

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** Each pane owns its WebView and anchor. Synchronization uses acknowledged tokens,
 * so a programmatic scroll can never echo back into the initiating document. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable fun PdfComparison(model:LibraryViewModel,state:LibraryState,firstId:String,onClose:()->Unit) {
    var secondId by rememberSaveable(firstId) {mutableStateOf("")}
    var sync by rememberSaveable {mutableStateOf(false)}
    var picking by remember {mutableStateOf(false)}
    val views=remember(model.repository.key){mutableMapOf<Int,DocumentWebView>()}
    val positions=remember(model.repository.key){mutableMapOf<Int,JSONObject>()}
    val candidates=state.records["books"].orEmpty().filter {it.id!=firstId&&it.text("format")=="pdf"}
    val scope=rememberCoroutineScope()
    val finish:()->Unit={scope.launch {model.resumeComparedBook(firstId).join();onClose()};Unit}
    BackHandler(onBack=finish)
    Surface(Modifier.fillMaxSize()) {Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween) {
            TextButton(onClick=finish){Text("结束对照")}
            TextButton(onClick={picking=true}){Text(if(secondId.isEmpty())"选择第二份 PDF"else "更换文档")}
        }
        Row(Modifier.fillMaxWidth()) {
            FilterChip(!sync,{sync=false},label={Text("独立滚动")},modifier=Modifier.weight(1f))
            FilterChip(sync,{sync=true},label={Text("同步滚动")},modifier=Modifier.weight(1f))
        }
        val position:(Int,JSONObject)->Unit={side,event->
            positions[side]=event
            if(sync&&event.optString("syncToken").isEmpty())views[1-side]?.javascript("pdfPosition",event.getInt("page"),event.optDouble("fraction"),UUID.randomUUID().toString())
        }
        val pane:@Composable (Int,String)->Unit={side,id->
            if(id.isNotEmpty())PdfComparisonPane(model,state,id,{view->if(view==null)views.remove(side)else views[side]=view},{event->position(side,event)},onClose)
            else Text("选择另一份 PDF，即可对照阅读。",Modifier.padding(24.dp))
        }
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            // Both sides need at least 360dp of actual available width.
            if(maxWidth>=720.dp)Row(Modifier.fillMaxSize()){Box(Modifier.weight(1f).fillMaxHeight()){pane(0,firstId)};VerticalDivider();Box(Modifier.weight(1f).fillMaxHeight()){pane(1,secondId)}}
            else Column(Modifier.fillMaxSize()){Box(Modifier.weight(1f).fillMaxWidth()){pane(0,firstId)};HorizontalDivider();Box(Modifier.weight(1f).fillMaxWidth()){pane(1,secondId)}}
        }
    }}
    if(picking)AlertDialog(onDismissRequest={picking=false},title={Text("选择对照文档")},text={LazyColumn {
        if(candidates.isEmpty())item {Text("先在书架导入第二份 PDF。")}
        items(candidates){book->TextButton(onClick={secondId=book.id;picking=false}){Text(book.text("title"))}}
    }},confirmButton={TextButton(onClick={picking=false}){Text("关闭")}})
}

@Composable private fun PdfComparisonPane(model:LibraryViewModel,state:LibraryState,id:String,onView:(DocumentWebView?)->Unit,onPosition:(JSONObject)->Unit,onClose:()->Unit) {
    val repo=model.repository
    val reportPosition by rememberUpdatedState(onPosition)
    val scope=rememberCoroutineScope()
    var book by remember(repo.key,id){mutableStateOf<Record?>(null)}
    var error by remember(repo.key,id){mutableStateOf("")}
    var ready by remember(repo.key,id){mutableStateOf(false)}
    var web by remember(repo.key,id){mutableStateOf<DocumentWebView?>(null)}
    var host by remember(repo.key,id){mutableStateOf<ReaderHost?>(null)}
    var tool by rememberSaveable(repo.key,id){mutableStateOf("browse")}
    val inkPages=remember(repo.key,id){mutableSetOf<Int>()}
    var selection by remember(repo.key,id){mutableStateOf<JSONObject?>(null)}
    val context=androidx.compose.ui.platform.LocalContext.current
    val prefs=remember(context){context.getSharedPreferences("pdf-comparison",0)}
    val key="${repo.key}:$id"
    var anchor by rememberSaveable(key){mutableStateOf(prefs.getString(key,"{\"page\":1,\"fraction\":0}")!!)}
    LaunchedEffect(repo.key,id){try {book=repo.get("books",id)}catch(e:Exception){error=e.message?:"无法打开 PDF"}}
    Column(Modifier.fillMaxSize()) {
        Text(book?.text("title")?:"读取文档…",Modifier.padding(horizontal=12.dp,vertical=4.dp),maxLines=2)
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())){
            TextButton(onClick={tool=if(tool=="pen")"browse"else "pen"}){Text(if(tool=="pen")"浏览"else "手写")}
            TextButton(onClick={tool="erase"}){Text("橡皮")}
            TextButton(onClick={host?.ink?.undo()}){Text("撤销")}
            TextButton(onClick={host?.ink?.redo()}){Text("重做")}
        }
        if(error.isNotEmpty())Text(error,Modifier.padding(16.dp),color=MaterialTheme.colorScheme.error)
        key(repo.key,id){AndroidView(factory={c->ReaderHost(c,scope){event->when(event.optString("type")) {
            "ready"->ready=true
            "pdfViewport"->{anchor=JSONObject().put("page",event.getInt("page")).put("fraction",event.optDouble("fraction")).toString();prefs.edit().putString(key,anchor).apply();reportPosition(event)
                val page=event.getInt("page");if(inkPages.add(page))scope.launch {try{val ink=model.loadInk(repo,id,page);if(host?.ink?.page==page)host?.ink?.load(ink)else inkPages.remove(page)}catch(e:Exception){inkPages.remove(page);model.loadInkPreview(repo,id,page)?.let {host?.ink?.preview(page,it)};error=e.message?:"读取手写失败"}}
            }
            "inkChanged"->model.saveInk(repo,id,event.getInt("page"),PortableInk.decode(event.getJSONObject("ink")))
            "selection"->selection=event
            "failure"->error=event.optString("error")
        }}.also {host=it;web=it.document;onView(it.document)}},modifier=Modifier.weight(1f).fillMaxWidth(),update={it.ink.tool=tool},onRelease={onView(null);it.document.destroy()})}
        selection?.let {event->TextButton(onClick={model.openComparedSelection(id,event);onClose()},modifier=Modifier.fillMaxWidth()){Text("学习此文档选区："+event.getJSONObject("anchor").optString("text").take(24))}}
    }
    LaunchedEffect(ready,book?.id){val full=book;if(ready&&full!=null)try {
        val file=File(repo.root,"comparison-${UUID.randomUUID()}.json")
        withContext(Dispatchers.IO){file.writeText(JSONObject().put("revision",full.revision).put("value",JSONObject(full.value.toString()).put("readerMode","original")).toString())}
        val source=repo.command("bookResource",JSONObject().put("id",id)).getString("path")
        web?.javascript("showBook",web!!.resource(file,"application/json"),web!!.resource(File(source)),"",JSONArray(state.records["highlights"].orEmpty().filter {it.text("bookId")==id}.map {it.value}),JSONObject().put("pdfAnchor",JSONObject(anchor)))
    }catch(e:Exception){error=e.message?:"读取原文件失败"}}
}
