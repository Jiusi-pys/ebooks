package org.shufang.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items as gridItems
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : ComponentActivity() {
    private val libraryModel:LibraryViewModel by viewModels()
    private var shareHandled=false
    private fun consumeShare(shared:Intent){if(shared.action==Intent.ACTION_SEND){shareHandled=true;@Suppress("DEPRECATION") val uri=shared.getParcelableExtra<android.net.Uri>(Intent.EXTRA_STREAM);uri?.let {libraryModel.import(it,"reflow")}}}
    override fun onNewIntent(intent:Intent){super.onNewIntent(intent);setIntent(intent);consumeShare(intent)}
    override fun onSaveInstanceState(outState:Bundle){outState.putBoolean("shareHandled",shareHandled);super.onSaveInstanceState(outState)}
    override fun onStart(){super.onStart();libraryModel.foreground(true)}
    override fun onStop(){libraryModel.foreground(false);super.onStop()}
    override fun onCreate(savedInstanceState:Bundle?) {
        super.onCreate(savedInstanceState);enableEdgeToEdge();shareHandled=savedInstanceState?.getBoolean("shareHandled")?:false
        setContent {
            val model=libraryModel
            val deviceState by model.state.collectAsStateWithLifecycle()
            AppleTheme(inkMode=deviceState.inkMode) {
                LaunchedEffect(Unit) {if(!shareHandled)consumeShare(intent)}
                LibraryApp(model)
            }
        }
    }
}
private val labels=linkedMapOf("books" to "书架","search" to "全局搜索","notes" to "笔记","highlights" to "书摘","mindMaps" to "脑图","review" to "复习","studySets" to "学习集","history" to "阅读记录","graph" to "图谱","folders" to "文件夹","translations" to "译文","associations" to "关联","ai" to "AI 阅读助手","settings" to "设置")

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun LibraryApp(model:LibraryViewModel) {
    val density=androidx.compose.ui.platform.LocalDensity.current
    BoxWithConstraints(Modifier.fillMaxSize()) {
        LibraryContent(model,AdaptiveLayout.calculate(maxWidth.value,maxHeight.value,density.fontScale))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun LibraryContent(model:LibraryViewModel,layout:AdaptiveLayout) {
    val state by model.state.collectAsStateWithLifecycle()
    var more by remember {mutableStateOf(false)}
    val context=LocalContext.current
    val keyboard=androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    val focus=androidx.compose.ui.platform.LocalFocusManager.current
    var editorKind by rememberSaveable {mutableStateOf<String?>(null)}
    var editorRecord by rememberSaveable(stateSaver=recordDraftSaver(context)) {mutableStateOf<Record?>(null)}
    fun edit(kind:String,record:Record){model.perform("读取编辑内容"){editorRecord=model.repository.get(kind,record.id);editorKind=kind}}
    var deleteRecords by remember {mutableStateOf<List<Record>>(emptyList())}
    var chosen by rememberSaveable {mutableStateOf(setOf<String>())}
    var moving by remember {mutableStateOf(false)}
    var selectedFolder by rememberSaveable {mutableStateOf<String?>(null)}
    var importMode by rememberSaveable {mutableStateOf("reflow")}
    val importer=rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) {uris->
        if(uris.size==1)model.import(uris.first(),importMode)
        else if(uris.isNotEmpty()) model.perform("批量导入") { for(uri in uris) { model.import(uri,importMode).join();while(model.state.value.importFile!=null)kotlinx.coroutines.delay(300) } }
    }
    var selectionActions by rememberSaveable {mutableStateOf(false)}
    BackHandler(state.view!="books") {model.navigate("books")}
    Scaffold(topBar={if(state.view!="reader")TopAppBar(colors=TopAppBarDefaults.topAppBarColors(containerColor=MaterialTheme.colorScheme.background),title={Column {Text(if(state.view=="reader")state.book?.text("title").orEmpty() else if(state.view=="books")"書房" else labels[state.view]?:"書房");Text(if(state.remote==null)"本地书库 · 离线可用" else state.remote!!.origin,style=MaterialTheme.typography.labelSmall)}},
        navigationIcon={if(state.view=="reader")IconButton(onClick={model.navigate("books")}){Icon(Icons.Default.ArrowBack,"返回书架")}},
        actions={IconButton(onClick={model.navigate("search")}){Icon(Icons.Default.Search,"全局搜索")};IconButton(onClick={model.syncNow()}){Icon(Icons.Default.Sync,"同步书库")};IconButton(onClick={more=true}){Icon(Icons.Default.Apps,"更多功能")}})},
        bottomBar={if(state.view!="reader"&&!layout.rail)ReadingNavigation(state.view) {key->chosen=emptySet();if(key=="review")model.reviewQueue()else model.navigate(key)}},
        floatingActionButton={if(chosen.isEmpty()&&state.view in listOf("books","notes","folders","mindMaps","studySets"))FloatingActionButton(containerColor=MaterialTheme.colorScheme.primary,contentColor=MaterialTheme.colorScheme.onPrimary,shape=RoundedCornerShape(22.dp),onClick={if(state.view=="books")importer.launch(arrayOf("application/*","text/*")) else {editorRecord=null;editorKind=state.view}}) {Icon(if(state.view=="books")Icons.Default.FileUpload else Icons.Default.Add,if(state.view=="books")"导入书籍" else "新建")}}
    ) {padding->Row(Modifier.padding(padding).fillMaxSize()) {
        if(layout.rail&&state.view!="reader")ReadingNavigationRail(state.view){key->chosen=emptySet();if(key=="review")model.reviewQueue()else model.navigate(key)}
        Column(Modifier.weight(1f).fillMaxHeight()) {
        if(state.busy.isNotEmpty()) {LinearProgressIndicator(Modifier.fillMaxWidth());Text(state.busy,Modifier.padding(horizontal=16.dp),style=MaterialTheme.typography.labelMedium)}
        if(state.error.isNotEmpty())Card(Modifier.fillMaxWidth().padding(12.dp),colors=CardDefaults.cardColors(containerColor=MaterialTheme.colorScheme.errorContainer)) {Row(Modifier.padding(12.dp),verticalAlignment=Alignment.CenterVertically) {Text(state.error,Modifier.weight(1f));TextButton(onClick=model::clearError){Text("关闭")}}}
        if(state.message.isNotEmpty())SelectionContainer {Text(state.message,Modifier.padding(12.dp),style=MaterialTheme.typography.bodySmall)}
        if(state.syncConflicts.isNotEmpty()&&state.view!="settings")Row(Modifier.fillMaxWidth().padding(horizontal=16.dp),verticalAlignment=Alignment.CenterVertically){Text("${state.syncConflicts.size} 项离线修改需要确认",Modifier.weight(1f));TextButton(onClick={model.navigate("settings")}){Text("查看冲突")}}
        if(state.associationSource!=null)Row(Modifier.padding(horizontal=12.dp)) {Text("正在关联：${state.associationSource!!.optString("text").take(30)}",Modifier.weight(1f));TextButton(onClick=model::cancelAssociation){Text("取消关联")}}
        if(!state.ready)Box(Modifier.fillMaxSize(),contentAlignment=Alignment.Center){CircularProgressIndicator()}
        else when(state.view) {
            "reader"->ReaderScreen(model,state,onSelection={selectionActions=true},onEdit={editorKind="books";editorRecord=state.book})
            "review"->ReviewScreen(model,state)
            "history"->HistoryScreen(state){model.openBook(it)}
            "graph"->KnowledgeGraphScreen(state){kind,id->if(kind=="books")model.openBook(id)else state.records[kind]?.find {it.id==id}?.let {edit(kind,it)}}
            "settings"->SettingsScreen(model,state,importMode,{importMode=it})
            "ai"->AiScreen(model,state)
            "search"->SearchScreen(model,state){kind,record->editorKind=kind;editorRecord=record}
            "studySetDetail"->StudySetPanel(model,state){kind,record->edit(kind,record)}
            else->{
                if(state.view=="books")CollectionHeading("把时间，留给阅读。","${state.records["books"].orEmpty().size} 本藏书  /  你的私人阅读空间")
                else if(state.view=="notes")CollectionHeading("想法，在这里生长。","${state.records["notes"].orEmpty().size} 篇笔记  /  记录与连接每一次思考")
                OutlinedTextField(state.query,model::query,keyboardOptions=androidx.compose.foundation.text.KeyboardOptions(imeAction=androidx.compose.ui.text.input.ImeAction.Search),keyboardActions=androidx.compose.foundation.text.KeyboardActions(onSearch={keyboard?.hide();focus.clearFocus()}),label={Text("搜索当前列表")},shape=MaterialTheme.shapes.medium,modifier=Modifier.fillMaxWidth().padding(horizontal=24.dp,vertical=12.dp),singleLine=true,leadingIcon={Icon(Icons.Default.Search,"筛选")},colors=OutlinedTextFieldDefaults.colors(unfocusedBorderColor=Color.Transparent,unfocusedContainerColor=MaterialTheme.colorScheme.surface,focusedContainerColor=MaterialTheme.colorScheme.surface))
                if(state.view=="books")Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal=12.dp)) {FilterChip(selectedFolder==null,{selectedFolder=null},label={Text("全部书籍")});for(folder in state.records["folders"].orEmpty())FilterChip(selectedFolder==folder.id,{selectedFolder=folder.id},label={Text(folder.text("name"))},modifier=Modifier.padding(start=8.dp))}
                if(chosen.isNotEmpty())Row(Modifier.padding(horizontal=12.dp),verticalAlignment=Alignment.CenterVertically) {
                    Text("已选 ${chosen.size} 项",Modifier.weight(1f));if(state.view=="books")TextButton(onClick={moving=true}){Text("移动")};TextButton(onClick={deleteRecords=state.records[state.view].orEmpty().filter {it.id in chosen}}){Text("批量删除")};TextButton(onClick={chosen=emptySet()}){Text("取消")}
                }
                val records=state.records[state.view].orEmpty().filter {(state.view!="books"||selectedFolder==null||it.text("folderId")==selectedFolder)&&(state.query.isBlank()||it.value.toString().contains(state.query,true))}
                if(records.isEmpty())Box(Modifier.weight(1f).fillMaxWidth(),contentAlignment=Alignment.Center){Text(if(state.query.isBlank())"这里还没有内容，点击 + 开始" else "没有匹配结果",color=MaterialTheme.colorScheme.onSurfaceVariant)}
                else LazyVerticalGrid(columns=if(state.view=="books")GridCells.Fixed(layout.coverColumns) else GridCells.Fixed(1),modifier=Modifier.weight(1f).testTag("library-grid"),contentPadding=PaddingValues(20.dp,12.dp,20.dp,96.dp),horizontalArrangement=Arrangement.spacedBy(18.dp),verticalArrangement=Arrangement.spacedBy(if(state.view=="books")22.dp else 0.dp)) {gridItems(records,key={it.id}) {record->
                    RecordCard(state.view,record,state,record.id in chosen,
                        onClick={if(chosen.isNotEmpty())chosen=if(record.id in chosen)chosen-record.id else chosen+record.id else when(state.view){"books"->model.openBook(record.id);"highlights"->model.openBook(record.text("bookId"),record.value);"translations"->model.openBook(record.text("bookId"),record.value);"studySets"->model.openStudySet(record.id);else->edit(state.view,record)}},
                        onSelect={chosen=if(record.id in chosen)chosen-record.id else chosen+record.id},onEdit={model.perform("读取编辑内容"){editorRecord=model.repository.get(state.view,record.id);editorKind=state.view}},onDelete={deleteRecords=listOf(record)},onReview={model.enableReview(record,record.value.isNull("review"))},onCite={note->model.cite(record,note)},onUncite={state.records["notes"].orEmpty().find {it.id==record.text("noteId")}?.let {model.uncite(record,it)}},onRemoveDownload={model.removeDownload(record)})
                }}
            }
        }
        if(state.importFile!=null)key(state.importFile!!.absolutePath){ImportDocument(model,state)}
        SaveConflictDialog(model,state)
        SyncConflictDialog(model,state)
        state.downloadBookId?.let {id->AlertDialog(onDismissRequest=model::dismissDownload,title={Text("重新下载原文件")},text={Text("本机下载已移除。书籍及学习记录仍保留，连接服务器后可重新下载："+state.records["books"].orEmpty().find {it.id==id}?.text("title").orEmpty())},confirmButton={TextButton(onClick=model::redownload,enabled=state.busy.isEmpty()){Text("重新下载")}},dismissButton={TextButton(onClick=model::dismissDownload){Text("取消")}})}
    }}}
    if(more)ModalBottomSheet(onDismissRequest={more=false},sheetState=rememberModalBottomSheetState(skipPartiallyExpanded=true)) {LazyColumn(modifier=Modifier.testTag("more-menu"),contentPadding=PaddingValues(16.dp)) {items(labels.entries.toList()) {(key,label)->ListItem(headlineContent={Text(label)},modifier=Modifier.clickable {more=false;chosen=emptySet();if(key=="review")model.reviewQueue()else model.navigate(key)})}}}
    editorKind?.let {kind->key(kind,editorRecord?.id){EntityEditor(kind,editorRecord,state,onDismiss={editorKind=null},onSave={patch->model.save(kind,editorRecord,patch){editorKind=null}},onLookup=model::lookupMetadata,onLoadBook={id,result->model.perform("读取书籍目录"){result(model.repository.get("books",id))}},onExpandMind={map,chapter->editorKind=null;model.expandMind(map,chapter)},onUncite={quote,note->model.uncite(quote,note){editorKind=null}},onCreateLink={title->model.save("notes",null,JSONObject().put("title",title.trim()).put("content","")){created->editorKind="notes";editorRecord=created}},onJump={targetKind,target,anchor->if(targetKind=="books"){editorKind=null;model.openBook(target.id,anchor)}else{edit(targetKind,target)}})}}
    if(moving)AlertDialog(onDismissRequest={moving=false},title={Text("移动所选书籍")},text={Column {TextButton(onClick={model.moveBooks(state.records["books"].orEmpty().filter {it.id in chosen},null);moving=false;chosen=emptySet()}){Text("移出文件夹")};for(folder in state.records["folders"].orEmpty())TextButton(onClick={model.moveBooks(state.records["books"].orEmpty().filter {it.id in chosen},folder.id);moving=false;chosen=emptySet()}){Text(folder.text("name"))}}},confirmButton={TextButton(onClick={moving=false}){Text("取消")}})
    if(deleteRecords.isNotEmpty())AlertDialog(onDismissRequest={deleteRecords=emptyList()},title={Text("删除 ${deleteRecords.size} 项？")},text={Text("删除操作将同步到连接的书库。书籍、笔记的关联清理由共享核心处理。")},confirmButton={TextButton(onClick={model.delete(state.view,deleteRecords);deleteRecords=emptyList();chosen=emptySet()}){Text("删除")}},dismissButton={TextButton(onClick={deleteRecords=emptyList()}){Text("取消")}})
    if(selectionActions&&state.selection!=null)SelectionSheet(model,state){selectionActions=false}
    state.mergeCounts?.let {counts->AlertDialog(onDismissRequest={model.cancelMerge()},title={Text("将本地内容合并到服务器书库")},text={Text(counts.filterValues {it>0}.entries.joinToString("\n"){(kind,count)->"${labels[kind]?:kind}：$count 项"}+"\n\n确认后先备份，再合并书籍、笔记及引用关系。原本地书库保留用于恢复。")},confirmButton={TextButton(onClick={model.confirmMerge()}){Text("确认整体合并")}},dismissButton={TextButton(onClick={model.cancelMerge()}){Text("保留本地并取消")}})}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun RecordCard(kind:String,record:Record,state:LibraryState,selected:Boolean,onClick:()->Unit,onSelect:()->Unit,onEdit:()->Unit,onDelete:()->Unit,onReview:()->Unit,onCite:(Record)->Unit,onUncite:()->Unit,onRemoveDownload:()->Unit) {
    var menu by remember {mutableStateOf(false)};var cite by remember {mutableStateOf(false)}
    val title=record.text("title").ifBlank {record.text("name").ifBlank {record.text("label").ifBlank {record.text("chapterTitle").ifBlank {record.text("text").take(80).ifBlank {"未命名"}}}}}
    if(kind=="books")Column(Modifier.fillMaxWidth().background(if(selected)MaterialTheme.colorScheme.primaryContainer else Color.Transparent,MaterialTheme.shapes.small).clickable(onClick=onClick).padding(4.dp)) {
        Box {
            CoverArtwork(record,Modifier.fillMaxWidth().aspectRatio(.72f))
            IconButton(onClick={menu=true},modifier=Modifier.align(Alignment.TopEnd).padding(5.dp).size(48.dp).background(MaterialTheme.colorScheme.surface.copy(alpha=.92f),RoundedCornerShape(24.dp))){Icon(Icons.Default.MoreHoriz,"$title 操作",Modifier.size(20.dp))}
        }
        Text(title,Modifier.padding(top=12.dp,bottom=6.dp),style=MaterialTheme.typography.titleSmall,fontWeight=FontWeight.SemiBold,maxLines=2,overflow=TextOverflow.Ellipsis)
        Text(record.text("author").ifBlank {"佚名"},style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant,maxLines=1,overflow=TextOverflow.Ellipsis)
        val ratio=record.value.optJSONObject("progress")?.optDouble("ratio",0.0)?.toFloat()?.takeIf {it.isFinite()}?.coerceIn(0f,1f)?:0f
        Row(Modifier.padding(top=8.dp),verticalAlignment=Alignment.CenterVertically) {
            Text(if(ratio>0)"已读 ${(ratio*100).toInt()}%" else record.text("format").uppercase(),style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
            if(selected){Spacer(Modifier.weight(1f));Icon(Icons.Default.CheckCircle,"已选择",Modifier.size(17.dp),tint=MaterialTheme.colorScheme.primary)}
        }
    } else Column(Modifier.fillMaxWidth().background(if(selected)MaterialTheme.colorScheme.primaryContainer else Color.Transparent).clickable(onClick=onClick)) {
        Row(Modifier.padding(vertical=18.dp,horizontal=4.dp),verticalAlignment=Alignment.Top) {
            Icon(if(kind=="notes")Icons.Default.Description else if(kind=="folders")Icons.Default.FolderOpen else Icons.Default.BookmarkBorder,null,Modifier.padding(top=3.dp,end=14.dp).size(22.dp),tint=MaterialTheme.colorScheme.onSurfaceVariant)
            Column(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(7.dp)) {
                Text(title,style=MaterialTheme.typography.titleMedium,maxLines=2,overflow=TextOverflow.Ellipsis)
                val subtitle=when(kind){"notes"->record.text("content");"highlights"->record.text("text")+if(record.text("note").isNotBlank())"\n批注："+record.text("note")else "";"studySets"->record.text("description");"mindMaps"->record.value.optJSONObject("root")?.optString("text").orEmpty();"associations"->record.value.optJSONObject("source")?.optString("text").orEmpty()+" ↔ "+record.value.optJSONObject("target")?.optString("text").orEmpty();else->record.text("text")}
                if(subtitle.isNotBlank())Text(subtitle.take(260),style=MaterialTheme.typography.bodyMedium,color=MaterialTheme.colorScheme.onSurfaceVariant,maxLines=3,overflow=TextOverflow.Ellipsis)
                if(kind=="mindMaps")record.value.optJSONObject("root")?.let {MindTree(it,0)}
            }
            IconButton(onClick={menu=true}){Icon(Icons.Default.MoreHoriz,"$title 操作",Modifier.size(20.dp))}
        }
        HorizontalDivider(color=MaterialTheme.colorScheme.outlineVariant.copy(alpha=.6f))
    }
                if(menu)ModalBottomSheet(onDismissRequest={menu=false},sheetState=rememberModalBottomSheetState(skipPartiallyExpanded=true)) {Column(Modifier.testTag("record-menu").verticalScroll(rememberScrollState()).padding(bottom=24.dp)) {
                    DropdownMenuItem(text={Text("编辑")},onClick={menu=false;onEdit()})
                    DropdownMenuItem(text={Text("选择 / 批量操作")},onClick={menu=false;onSelect()})
                    if(kind=="books")DropdownMenuItem(text={Text("移除本机下载 · 保留书籍及笔记")},onClick={menu=false;onRemoveDownload()})
                    if(kind=="highlights") {DropdownMenuItem(text={Text(if(record.value.isNull("review"))"加入复习" else "移出复习")},onClick={menu=false;onReview()});DropdownMenuItem(text={Text("引用到笔记")},onClick={menu=false;cite=true})}
                    if(kind=="highlights"&&record.text("noteId").isNotBlank())DropdownMenuItem(text={Text("取消引用")},onClick={menu=false;onUncite()})
                    DropdownMenuItem(text={Text("删除")},onClick={menu=false;onDelete()})
                }}
    if(cite)AlertDialog(onDismissRequest={cite=false},title={Text("选择引用笔记")},text={Column(Modifier.verticalScroll(rememberScrollState())) {for(note in state.records["notes"].orEmpty())TextButton(onClick={cite=false;onCite(note)}){Text(note.text("title"))}}},confirmButton={TextButton(onClick={cite=false}){Text("取消")}})
}

@Composable private fun MindTree(node:JSONObject,depth:Int) {
    if(depth>16)return
    Text("${"  ".repeat(depth)}${if(depth==0)"●"else "└"} ${node.optString("text")}",style=MaterialTheme.typography.bodySmall)
    if(!node.optBoolean("collapsed"))node.optJSONArray("children")?.let {children->repeat(children.length()){MindTree(children.getJSONObject(it),depth+1)}}
}

@Composable private fun BookCover(book:Record) {
    val data=book.text("customCover").ifBlank {book.text("cover")}
    val bitmap=remember(data){runCatching {if(data.startsWith("data:image/")){val bytes=android.util.Base64.decode(data.substringAfter(','),android.util.Base64.DEFAULT);android.graphics.BitmapFactory.decodeByteArray(bytes,0,bytes.size)?.asImageBitmap()}else null}.getOrNull()}
    if(bitmap!=null)Image(bitmap,book.text("title"),modifier=Modifier.width(62.dp).height(88.dp).padding(end=10.dp),contentScale=androidx.compose.ui.layout.ContentScale.Crop)
    else Box(Modifier.width(54.dp).height(80.dp).padding(end=8.dp).background(MaterialTheme.colorScheme.secondaryContainer),contentAlignment=Alignment.Center){Text(book.text("title").take(8),Modifier.padding(6.dp),style=MaterialTheme.typography.labelMedium)}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun EntityEditor(kind:String,record:Record?,state:LibraryState,onDismiss:()->Unit,onSave:(JSONObject)->Unit,onLookup:(String)->Unit,onLoadBook:(String,(Record)->Unit)->Unit,onExpandMind:(Record,String)->Unit,onUncite:(Record,Record)->Unit,onCreateLink:(String)->Unit,onJump:(String,Record,JSONObject?)->Unit) {
    val value=record?.value?:JSONObject()
    val editorContext=LocalContext.current
    val draftSaver=draftStringSaver(LocalContext.current)
    val titleKey=if(kind=="associations")"label"else if(kind in listOf("folders","studySets","highlights"))"name"else "title"
    var title by rememberSaveable {mutableStateOf(value.optString(titleKey))}
    var content by rememberSaveable(stateSaver=draftSaver) {mutableStateOf(value.optString(if(kind=="notes")"content"else if(kind=="highlights")"note"else if(kind=="translations")"text"else "description"))}
    var author by rememberSaveable {mutableStateOf(value.optString("author"))}
    var tags by rememberSaveable {mutableStateOf(value.optJSONArray("tags")?.let {a->(0 until a.length()).joinToString(","){a.optString(it)}}?:"")}
    var cloze by rememberSaveable {mutableStateOf(value.optJSONArray("cloze")?.let {a->(0 until a.length()).joinToString(","){a.optString(it)}}?:"")}
    var advanced by remember {mutableStateOf(when(kind){"books"->value.optJSONObject("metadata")?.toString(2)?:"{\"version\":1}";"mindMaps"->value.optJSONObject("root")?.toString(2)?:"";else->""})}
    var metadata by rememberSaveable(stateSaver=jsonDraftSaver(LocalContext.current)) {mutableStateOf(value.optJSONObject("metadata")?:JSONObject().put("version",1))}
    var mindRoot by rememberSaveable(stateSaver=jsonDraftSaver(LocalContext.current)) {mutableStateOf(value.optJSONObject("root")?:JSONObject().put("id",UUID.randomUUID().toString()).put("text","中心主题").put("children",JSONArray()))}
    var mindBook by rememberSaveable {mutableStateOf(value.optString("bookId"))}
    var focusNode by rememberSaveable {mutableStateOf("")}
    var selectedBooks by rememberSaveable {mutableStateOf(value.optJSONArray("bookIds")?.let {a->(0 until a.length()).map {a.getString(it)}.toSet()}?:setOf())}
    var folder by rememberSaveable {mutableStateOf(value.optString("folderId"))}
    var folderIcon by rememberSaveable {mutableStateOf(value.optString("icon","folder"))}
    var associationDirection by rememberSaveable {mutableStateOf(value.optString("direction","bidirectional"))}
    var error by remember {mutableStateOf("")}
    val canJump=title==value.optString(titleKey) && content==value.optString(if(kind=="notes")"content"else if(kind=="highlights")"note"else if(kind=="translations")"text"else "description") && (kind!="mindMaps" || (mindRoot.toString()==value.optJSONObject("root")?.toString()&&mindBook==value.optString("bookId"))) && (kind!="associations"||associationDirection==value.optString("direction","bidirectional"))
    ModalBottomSheet(onDismissRequest=onDismiss,sheetState=rememberModalBottomSheetState(skipPartiallyExpanded=true)) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().padding(20.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            Text("${if(record==null)"新建"else "编辑"}${labels[kind]?:kind}",style=MaterialTheme.typography.headlineSmall)
            if(kind!="translations")OutlinedTextField(title,{title=it},label={Text(if(titleKey=="name")"名称"else "标题")},modifier=Modifier.fillMaxWidth())
            if(kind=="books") {
                OutlinedTextField(author,{author=it},label={Text("作者")},modifier=Modifier.fillMaxWidth())
                Text("移动到文件夹");Row(Modifier.horizontalScroll(rememberScrollState())) {for(item in state.records["folders"].orEmpty())FilterChip(selected=folder==item.id,onClick={folder=item.id},label={Text(item.text("name"))},modifier=Modifier.padding(end=8.dp))}
                TextButton(onClick={onLookup("$title $author")}){Text("在线检索元数据")}
                for(candidate in state.metadataCandidates)TextButton(onClick={title=candidate.optString("title");author=candidate.optString("author");metadata=candidate.getJSONObject("metadata")}){Text(candidate.optString("title")+" · "+candidate.optString("author"))}
                MetadataFields(metadata){metadata=it}
            }
            if(kind in listOf("notes","highlights","studySets","translations"))OutlinedTextField(content,{content=it},label={Text(if(kind=="notes")"正文 · 支持 [[双链]]"else if(kind=="highlights")"批注"else "内容")},modifier=Modifier.fillMaxWidth(),minLines=if(kind=="notes")8 else 3)
            if(kind=="folders")Row(Modifier.horizontalScroll(rememberScrollState())) {for((icon,label) in listOf("folder" to "文件夹","library" to "藏书","study" to "学习","archive" to "归档","work" to "工作","heart" to "喜爱","sparkles" to "灵感","bookmark" to "收藏"))FilterChip(selected=folderIcon==icon,onClick={folderIcon=icon},label={Text(label)})}
            if(kind=="notes") {
                Row(Modifier.horizontalScroll(rememberScrollState())) {for((label,marker)in listOf("标题" to "\n## ","列表" to "\n- ","引用" to "\n> ","加粗" to "**文字**","代码" to "`代码`","双链" to "[[笔记标题]]"))TextButton(onClick={content+=marker}){Text(label)}}
                val links=Regex("\\[\\[([^]\\n]+)]]").findAll(content).map {it.groupValues[1].trim()}.filter {it.isNotEmpty()}.distinctBy {it.lowercase()}.toList()
                for(link in links) {
                    val target=wikiTarget(link,state.records)
                    if(target!=null)TextButton(enabled=canJump,onClick={onJump(target.first,target.second,null)}){Text("打开${if(target.first=="books")"书籍"else "笔记"}：$link")}
                    else TextButton(enabled=canJump,onClick={onCreateLink(link)}){Text("创建关联笔记：$link")}
                }
                for(match in Regex("shufang-citation-id:([^\\s>]+)").findAll(content)) {
                    val id=runCatching {java.net.URLDecoder.decode(match.groupValues[1],"UTF-8")}.getOrNull()
                    val quote=state.records["highlights"].orEmpty().find {it.id==id}
                    val source=quote?.let {q->state.records["books"].orEmpty().find {it.id==q.text("bookId")}}
                    if(quote!=null && source!=null)TextButton(enabled=canJump,onClick={onJump("books",source,quote.value)}){Text("跳转引用：${quote.text("text").take(45)}")}
                    if(quote!=null&&record!=null&&quote.text("noteId")==record.id)TextButton(enabled=canJump,onClick={onUncite(quote,record)}){Text("取消引用：${quote.text("text").take(45)}")}
                }
                val backlinks=state.records["notes"].orEmpty().filter {it.id!=record?.id && Regex("\\[\\[([^]\\n]+)]]").findAll(it.text("content")).any {match->match.groupValues[1].trim().equals(title.trim(),ignoreCase=true)}}
                for(link in backlinks)TextButton(enabled=canJump,onClick={onJump("notes",link,null)}){Text("反向链接：${link.text("title")}")}
                if(!canJump&&(links.isNotEmpty()||backlinks.isNotEmpty()||content.contains("shufang-citation-id:")))Text("请先保存修改，再跳转关联内容")
                MarkdownPreview(content)
                TextButton(onClick={Sharing.text(editorContext,"笔记",content)}){Text("分享笔记")}
            }
            if(kind=="highlights") {OutlinedTextField(tags,{tags=it},label={Text("标签，逗号分隔")});OutlinedTextField(cloze,{cloze=it},label={Text("挖空词，逗号分隔")});Text(value.optString("text"));value.optJSONArray("aiQa")?.let {qa->repeat(qa.length()){turn->val item=qa.getJSONObject(turn);Text("提问：${item.optString("q")}");SelectionContainer {Text(item.optString("a"))}}}}
            if(kind=="studySets"&&record==null)Row(Modifier.horizontalScroll(rememberScrollState())) {for((name,summary) in listOf("申论素材" to "积累论点、案例和规范表达；用挖空复习关键词。","论文研究" to "记录问题、方法和结论；关联支持观点、反例与待验证内容。"))TextButton(onClick={title=name;content=summary}){Text(name)}}
            if(kind=="studySets")for(book in state.records["books"].orEmpty())Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically){Checkbox(book.id in selectedBooks,{selectedBooks=if(it)selectedBooks+book.id else selectedBooks-book.id});Text(book.text("title"))}
            if(kind=="associations") {
                Row {for((direction,label)in listOf("bidirectional" to "双向关联","source-to-target" to "源到目标"))FilterChip(associationDirection==direction,{associationDirection=direction},label={Text(label)})}
                for((key,label)in listOf("source" to "源文段","target" to "目标文段"))value.optJSONObject(key)?.let {anchor->Text("$label：${anchor.optString("text")}");state.records["books"].orEmpty().find {it.id==anchor.optString("bookId")}?.let {book->TextButton(enabled=canJump,onClick={onJump("books",book,anchor)}){Text("打开$label")}}}
                if(!canJump)Text("请先保存修改，再跳转文段")
            }
            if(kind=="mindMaps") {
                var canvas by rememberSaveable {mutableStateOf(false)}
                Row {FilterChip(!canvas,{canvas=false},label={Text("大纲")});Spacer(Modifier.width(8.dp));FilterChip(canvas,{canvas=true},label={Text("树形画布")})}
                if(canvas)MindCanvas(mindRoot,focusNode.ifEmpty {mindRoot.optString("id")},{focusNode=it})
                Text("关联书籍");Row(Modifier.horizontalScroll(rememberScrollState())) {state.records["books"].orEmpty().forEach {book->FilterChip(mindBook==book.id,{mindBook=book.id},label={Text(book.text("title"))})}}
                if(record==null&&mindBook.isNotEmpty())TextButton(onClick={onLoadBook(mindBook){book->mindRoot=mindFromBook(book);title="${book.text("title")} 脑图"}}){Text("从书籍目录生成脑图")}
                Text("焦点子树");Row(Modifier.horizontalScroll(rememberScrollState())) {FilterChip(focusNode.isEmpty(),{focusNode=""},label={Text("完整脑图")});mindNodes(mindRoot).forEach {node->FilterChip(focusNode==node.optString("id"),{focusNode=node.optString("id")},label={Text(node.optString("text").take(16))})}}
                val focused=findMindNode(mindRoot,focusNode)?:mindRoot
                MindMoveMenu(mindRoot,focused.optString("id"),{mindRoot=it})
                MindNodeEditor(focused,state.records["highlights"].orEmpty(),{mindRoot=replaceMindNode(mindRoot,focused.getString("id"),it)},onSource={quote->if(canJump)state.records["books"].orEmpty().find {it.id==quote.text("bookId")}?.let {onJump("books",it,quote.value)}else error="请先保存脑图，再跳转来源"})
                for(node in mindNodes(focused).filter {it.has("chapterId")})TextButton(enabled=canJump,onClick={state.records["books"].orEmpty().find {it.id==mindBook}?.let {onJump("books",it,JSONObject().put("chapterId",node.getString("chapterId")).put("readerMode","reflow"))}}){Text("打开章节：${node.optString("text")}")}
                if(record!=null&&mindBook.isNotBlank())for(node in mindNodes(focused).filter {it.has("chapterId")})TextButton(enabled=canJump,onClick={onExpandMind(record,node.getString("chapterId"))}){Text("AI 展开章节：${node.optString("text")}")}
            }
            if(error.isNotEmpty())Text(error,color=MaterialTheme.colorScheme.error)
            if(state.error.isNotEmpty())Text(state.error,color=MaterialTheme.colorScheme.error)
            Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.End) {TextButton(onClick=onDismiss){Text("取消")};Button(onClick={try {
                val patch=JSONObject()
                when(kind) {
                    "notes"->patch.put("title",title).put("content",content)
                    "folders"->patch.put("name",title).put("icon",folderIcon)
                    "books"->{patch.put("title",title).put("author",author).put("metadata",metadata);if(folder.isNotBlank())patch.put("folderId",folder)}
                    "highlights"->patch.put("name",title).put("note",content).put("tags",JSONArray(tags.split(',').map {it.trim()}.filter {it.isNotEmpty()})).put("cloze",JSONArray(cloze.split(',').map {it.trim()}.filter {it.isNotEmpty()}))
                    "studySets"->patch.put("name",title).put("description",content).put("bookIds",JSONArray(selectedBooks.toList()))
                    "mindMaps"->{patch.put("title",title).put("root",mindRoot);if(mindBook.isNotBlank())patch.put("bookId",mindBook)}
                    "translations"->patch.put("text",content).put("targetLang",value.optString("targetLang","中文"))
                    "associations"->patch.put("label",title).put("direction",associationDirection)
                }
                onSave(patch)
            }catch(reason:Exception){error=reason.message.orEmpty()}}){Text("保存")}}
            Spacer(Modifier.height(32.dp))
        }
    }
}

@Composable private fun ImportDocument(model:LibraryViewModel,state:LibraryState) {
    val scope=rememberCoroutineScope()
    var started by remember(state.importFile?.absolutePath) {mutableStateOf(false)}
    Box(Modifier.size(1.dp)) {AndroidView(factory={context->DocumentWebView(context,scope) {event->
        if(event.optString("type")=="ready")started=true else model.documentEvent(event)
    }},update={view->if(started){started=false;val file=state.importFile!!;view.javascript("importFile",view.resource(file),state.importName,state.importMode)}},onRelease={it.destroy()})}
    if(!state.importSaving)TextButton(onClick=model::cancelImport){Text("取消当前导入")}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun ReaderScreen(model:LibraryViewModel,state:LibraryState,onSelection:()->Unit,onEdit:()->Unit) {
    val systemFontScale=androidx.compose.ui.platform.LocalDensity.current.fontScale
    val scope=rememberCoroutineScope();var ready by remember(model.repository.key,state.book?.id) {mutableStateOf(false)};var document by remember(model.repository.key,state.book?.id) {mutableStateOf<DocumentWebView?>(null)}
    var fontSize by rememberSaveable {mutableFloatStateOf(19f)};var chapterMenu by remember {mutableStateOf(false)};var immersive by rememberSaveable {mutableStateOf(false)}
    var typePanel by remember {mutableStateOf(false)};var sidePanel by rememberSaveable {mutableStateOf("")}
    var translationMenu by remember {mutableStateOf(false)}
    var readerMore by remember {mutableStateOf(false)}
    var comparing by rememberSaveable(model.repository.key,state.book?.id) {mutableStateOf(false)}
    var host by remember(model.repository.key,state.book?.id) {mutableStateOf<ReaderHost?>(null)}
    var inkTool by rememberSaveable {mutableStateOf("browse")}
    var inkPage by remember {mutableIntStateOf(0)}
    val inkRepo=remember(model.repository.key,state.book?.id){model.repository}
    val loadedInk=remember(model.repository.key,state.book?.id){mutableSetOf<Int>()}
    val wide=LocalConfiguration.current.screenWidthDp>=600
    var readerInteraction by remember {mutableStateOf(false)}
    var citeLevel by remember {mutableStateOf("")};var renameEntry by remember {mutableStateOf<JSONObject?>(null)};var entryTitle by remember {mutableStateOf("")}
    LaunchedEffect(inkTool,immersive,typePanel,chapterMenu,sidePanel,readerMore,readerInteraction,state.selection) {if(inkTool=="browse"&&!immersive&&!typePanel&&!chapterMenu&&sidePanel.isEmpty()&&!readerMore&&!readerInteraction&&state.selection==null){kotlinx.coroutines.delay(4000);immersive=true}}
    val book=state.book?:return
    var requestedAnchor by remember(book.id){mutableStateOf(state.anchor)}
    var requestedChapter by remember(book.id){mutableStateOf(state.chapterId)}
    LaunchedEffect(state.chapterId,state.anchor?.toString()) {
        if(state.anchor!=null||state.chapterId!=requestedChapter)requestedAnchor=state.anchor
        requestedChapter=state.chapterId
    }
    if(comparing){PdfComparison(model,state,book.id){comparing=false};return}
    val generalType=runCatching {JSONObject(state.records["preferences"].orEmpty().find {it.id=="shufang-type2"}?.text("value")?:"{}")}.getOrDefault(JSONObject())
    val coverPicker=rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()){uri->uri?.let {model.setCover(book,it)}}
    Box(Modifier.fillMaxSize()) {
            key(inkRepo.key,book.id){AndroidView(factory={context->ready=false;ReaderHost(context,scope) {event->when(event.optString("type")){
                "ready"->ready=true
                "inkChanged"->model.saveInk(inkRepo,book.id,event.getInt("page"),PortableInk.decode(event.getJSONObject("ink")))
                "pdfViewport"->{val page=event.getInt("page");inkPage=page;if(loadedInk.add(page))scope.launch {try {val ink=model.loadInk(inkRepo,book.id,page);if(host?.ink?.page==page)host?.ink?.load(ink)else loadedInk.remove(page)}catch(error:Exception){loadedInk.remove(page);runCatching {model.loadInkPreview(inkRepo,book.id,page)?.let {host?.ink?.preview(page,it)}};model.documentEvent(JSONObject().put("type","failure").put("error",error.message))}}}
                "toggleControls"->{immersive=!immersive}
                "selectionState","panelState"->{readerInteraction=event.optBoolean("active")}
                else->model.documentEvent(event)
            }}.also {host=it;document=it.document}},modifier=Modifier.fillMaxSize(),update={it.ink.tool=inkTool},onRelease={it.document.destroy();if(document===it.document){ready=false;document=null;host=null;loadedInk.clear()}})}
        if(!immersive)Row(Modifier.align(Alignment.TopCenter).padding(horizontal=16.dp,vertical=8.dp).fillMaxWidth().background(MaterialTheme.colorScheme.surface, RoundedCornerShape(18.dp)).horizontalScroll(rememberScrollState()).padding(horizontal=8.dp),verticalAlignment=Alignment.CenterVertically) {
            IconButton(onClick={model.navigate("books")}){Icon(Icons.AutoMirrored.Filled.ArrowBack,"返回书架")}
            IconButton(onClick={model.navigate("search")}){Icon(Icons.Default.Search,"全局搜索")}
            TextButton(onClick={chapterMenu=true}){Icon(Icons.Default.List,null,Modifier.size(18.dp));Spacer(Modifier.width(6.dp));Text("目录")}
            TextButton(onClick={typePanel=true}){Text("Aa");Spacer(Modifier.width(6.dp));Text("排版")}
            TextButton(onClick={sidePanel=if(sidePanel=="notes")""else "notes"}){Text("笔记")}
            TextButton(onClick=model::openAi){Text("AI")}
            if(book.text("format")=="pdf"&&book.text("readerMode")=="original"){TextButton(onClick={inkTool=if(inkTool=="pen")"browse"else "pen";host?.ink?.tool=inkTool}){Text(if(inkTool=="pen")"浏览"else "手写")};TextButton(onClick={inkTool="erase";host?.ink?.tool=inkTool}){Text("橡皮")};TextButton(onClick={host?.ink?.undo()}){Text("撤销")};TextButton(onClick={host?.ink?.redo()}){Text("重做")}}

            IconButton(onClick={readerMore=true}){Icon(Icons.Default.MoreHoriz,"更多阅读工具")}
        }
        if(state.selection!=null)TextButton(onClick=onSelection,modifier=Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(MaterialTheme.colorScheme.surface)){Text("选文操作：${state.selection!!.optString("text").take(35)}")}

        LaunchedEffect(ready,book.id,book.text("readerMode"),state.inkMode,systemFontScale,state.chapterId,requestedAnchor?.toString(),state.records["highlights"].orEmpty().filter {it.text("bookId")==book.id}.joinToString {it.value.toString()},book.value.optJSONObject("typeSettings")?.toString(),generalType.toString(),book.value.optJSONArray("chapters")?.toString()) {if(ready) {
            val file=File(model.repository.root,"reader-${book.id}.json")
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO){val rendered=JSONObject(book.value.toString());if(rendered.optJSONObject("typeSettings")==null)rendered.put("typeSettings",JSONObject(generalType.toString()));rendered.getJSONObject("typeSettings").put("inkMode",state.inkMode).put("fontSize",rendered.getJSONObject("typeSettings").optDouble("fontSize",19.0)*systemFontScale);file.writeText(JSONObject().put("revision",book.revision).put("value",rendered).toString())}
            val source=model.repository.command("bookResource",JSONObject().put("id",book.id)).getString("path")
            val quotes=JSONArray(state.records["highlights"].orEmpty().filter {it.text("bookId")==book.id}.map {it.value})
            document?.javascript("showBook",document!!.resource(file,"application/json"),document!!.resource(File(source)),state.chapterId,quotes,requestedAnchor)
        }}
    }
    if(sidePanel.isNotEmpty()) {
        val panelContent:@Composable ()->Unit={Column(Modifier.fillMaxWidth().heightIn(max=(LocalConfiguration.current.screenHeightDp*.8f).dp)){Row(verticalAlignment=Alignment.CenterVertically){Text(if(sidePanel=="notes")"学习笔记"else "学习卡片",Modifier.weight(1f),style=MaterialTheme.typography.titleLarge);TextButton(onClick={sidePanel=""}){Text("关闭")}};LazyColumn {items(state.records[sidePanel].orEmpty().filter {sidePanel=="notes"||it.text("bookId")==book.id}) {record->ListItem(headlineContent={Text(record.text("title").ifBlank {record.text("text").take(100)})},supportingContent={Text(record.text("content").ifBlank {record.text("note")}.take(100))},modifier=Modifier.clickable {if(sidePanel=="highlights")model.openBook(book.id,record.value)else model.navigate("notes");sidePanel=""})}}}}
        if(wide)androidx.compose.ui.window.Dialog(onDismissRequest={sidePanel=""}){Surface(shape=MaterialTheme.shapes.large){Box(Modifier.widthIn(max=420.dp).padding(16.dp)){panelContent()}}}
        else ModalBottomSheet(onDismissRequest={sidePanel=""},sheetState=rememberModalBottomSheetState(skipPartiallyExpanded=true)){Box(Modifier.padding(16.dp)){panelContent()}}
    }
    state.ocrText?.let {text->var corrected by rememberSaveable(text){mutableStateOf(text)};AlertDialog(onDismissRequest=model::dismissOcr,title={Text("校正第 ${state.ocrPage} 页文字")},text={OutlinedTextField(corrected,{corrected=it},modifier=Modifier.heightIn(max=360.dp).verticalScroll(rememberScrollState()),label={Text("识别结果，可编辑")},minLines=6)},confirmButton={TextButton(onClick={model.saveOcr(corrected)}){Text("保存为卡片")}},dismissButton={TextButton(onClick=model::dismissOcr){Text("取消")}})}
    if(typePanel)TypePanel(book.value.optJSONObject("typeSettings")?:generalType,{typePanel=false},onSave={settings->model.save("books",book,JSONObject().put("typeSettings",settings))},general=generalType,onGeneral={model.preference("shufang-type2",it.toString())},onReset=model::resetBookType)
    if(citeLevel.isNotEmpty())AlertDialog(onDismissRequest={citeLevel=""},title={Text("选择引用笔记")},text={LazyColumn {items(state.records["notes"].orEmpty()){note->TextButton(onClick={model.createCitation(citeLevel,note);citeLevel=""}){Text(note.text("title"))}}}},confirmButton={TextButton(onClick={citeLevel=""}){Text("取消")}})
    if(chapterMenu)AlertDialog(onDismissRequest={chapterMenu=false},title={Text("目录 · 触摸编辑")},text={LazyColumn {
        val chapters=book.value.optJSONArray("chapters")?:JSONArray()
        val outline=book.value.optJSONArray("outline")?:JSONArray((0 until chapters.length()).map {chapters.getJSONObject(it).let {chapter->JSONObject().put("id","chapter:"+chapter.getString("id")).put("chapterId",chapter.getString("id")).put("title",chapter.optString("title")).put("depth",0)}})
        items((0 until outline.length()).map {outline.getJSONObject(it)}) {entry->Column {
            TextButton(onClick={model.openBook(book.id,entry);chapterMenu=false}){Text("  ".repeat(entry.optInt("depth"))+entry.optString("title"))}
            Row(Modifier.horizontalScroll(rememberScrollState())) {TextButton(onClick={renameEntry=entry;entryTitle=entry.optString("title")}){Text("改名")};for((action,label)in listOf("up" to "上移","down" to "下移","indent" to "缩进","outdent" to "提升"))TextButton(onClick={model.outline(action,entry.getString("id"))}){Text(label)};if(!entry.getString("id").startsWith("chapter:"))TextButton(onClick={model.outline("delete",entry.getString("id"))}){Text("删除")}}
        }}
    }},confirmButton={TextButton(onClick={chapterMenu=false}){Text("关闭")}})
    renameEntry?.let {entry->AlertDialog(onDismissRequest={renameEntry=null},title={Text("目录标题")},text={OutlinedTextField(entryTitle,{entryTitle=it},label={Text("标题")})},confirmButton={TextButton(onClick={model.outline("rename",entry.getString("id"),entryTitle);renameEntry=null}){Text("保存")}},dismissButton={TextButton(onClick={renameEntry=null}){Text("取消")}})}
    if(readerMore)ModalBottomSheet(onDismissRequest={readerMore=false},sheetState=rememberModalBottomSheetState(skipPartiallyExpanded=true)) {
        Column(Modifier.fillMaxWidth().heightIn(max=(LocalConfiguration.current.screenHeightDp*.8f).dp).verticalScroll(rememberScrollState()).padding(start=24.dp,end=24.dp,bottom=32.dp),verticalArrangement=Arrangement.spacedBy(6.dp)) {
            Text("阅读工具",style=MaterialTheme.typography.titleLarge)
            Text("让阅读按你的习惯展开",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
            Row(verticalAlignment=Alignment.CenterVertically){Text("字号",Modifier.weight(1f));TextButton(onClick={model.adjustFont(-1)}){Text("A−")};TextButton(onClick={model.adjustFont(1)}){Text("A+")}}
            HorizontalDivider()
            TextButton(onClick={translationMenu=true;readerMore=false}){Text("双语阅读")}
            TextButton(onClick={sidePanel=if(sidePanel=="highlights")""else "highlights";readerMore=false}){Text("书摘")}
            TextButton(onClick={citeLevel="book";readerMore=false}){Text("引用全书")}
            TextButton(onClick={citeLevel="chapter";readerMore=false}){Text("引用章节")}
            TextButton(onClick={onEdit();readerMore=false}){Text("书目")}
            TextButton(onClick={coverPicker.launch(arrayOf("image/*"));readerMore=false}){Text("封面")}
            TextButton(onClick={model.shareOriginal(book);readerMore=false}){Text("分享原文件")}
            if(book.text("format")=="pdf") {
                TextButton(onClick={model.togglePdfMode(book);readerMore=false}){Text("切换版式")}
                if(book.text("readerMode")=="original") {
                    TextButton(onClick={document?.javascript("pdfThumbnails");readerMore=false}){Text("页面缩略图")}
                    TextButton(onClick={comparing=true;readerMore=false}){Text("双文档对照")}
                    TextButton(onClick={document?.javascript("pdfRegion",true);readerMore=false}){Text("框选区域摘录")}
                    TextButton(onClick={document?.javascript("ocrPage");readerMore=false}){Text("识别本页文字")}
                    for((mode,label) in listOf("vertical" to "上下滚动","horizontal" to "左右滚动","double" to "双页阅读"))TextButton(onClick={document?.javascript("pdfLayout",mode);readerMore=false}){Text(label)}
                    TextButton(onClick={host?.ink?.fingerDrawing=!(host?.ink?.fingerDrawing?:false);readerMore=false}){Text("切换手指书写 / 手指浏览")}
                    TextButton(onClick={readerMore=false;scope.launch {try {val pages=JSONArray();for(note in inkRepo.list("notes").filter {it.text("bookId")==book.id&&it.value.has("pdfPage")}){val full=inkRepo.get("notes",note.id);val page=JSONObject().put("page",full.value.getInt("pdfPage"));val ink=full.value.optJSONObject("pdfPortableInk");if(ink!=null){val resource=inkRepo.command("attachmentResource",JSONObject().put("reference",ink));page.put("ink",JSONObject(File(resource.getString("path")).readText()))}else full.value.optJSONObject("pdfPreview")?.let {reference->val resource=inkRepo.command("attachmentResource",JSONObject().put("reference",reference));page.put("preview",document!!.resource(File(resource.getString("path")),"image/png"))};pages.put(page)};document?.javascript("exportPdf",pages)}catch(error:Exception){model.documentEvent(JSONObject().put("type","failure").put("error",error.message))}}}){Text("导出带批注 PDF")}
                }
            }
            TextButton(onClick={immersive=true;readerMore=false}){Text("沉浸")}
        }
    }
    if(translationMenu)AlertDialog(onDismissRequest={translationMenu=false},title={Text("本章双语阅读")},text={Column(Modifier.verticalScroll(rememberScrollState())) {
        val translations=state.records["translations"].orEmpty().filter {it.text("bookId")==book.id && it.text("chapterId")==state.chapterId}
        if(translations.isEmpty())Text("本章还没有已保存的译文，可在 AI 面板翻译当前章节并保存。")
        for(translation in translations)TextButton(onClick={model.perform("读取译文"){val full=model.repository.get("translations",translation.id);document?.javascript("showTranslation",full.text("text"))};translationMenu=false}){Text(translation.text("targetLang")+" · "+translation.text("text").take(40))}
        TextButton(onClick={document?.javascript("showTranslation","");translationMenu=false}){Text("只显示原文")}
    }},confirmButton={TextButton(onClick={model.dismissSelection();model.navigate("settings");translationMenu=false}){Text("打开 AI 翻译")}},dismissButton={TextButton(onClick={translationMenu=false}){Text("关闭")}})
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun SelectionSheet(model:LibraryViewModel,state:LibraryState,onDismiss:()->Unit) {
    val context=androidx.compose.ui.platform.LocalContext.current
    var note by rememberSaveable(stateSaver=draftStringSaver(context)) {mutableStateOf(state.selection?.optString("note").orEmpty())}
    var color by rememberSaveable {mutableStateOf(state.selection?.optJSONObject("style")?.optString("color","yellow")?:"yellow")}
    var style by rememberSaveable {mutableStateOf(state.selection?.optJSONObject("style")?.optString("kind","background")?:"background")}
    var citing by remember {mutableStateOf(false)}
    ModalBottomSheet(onDismissRequest=onDismiss) {Column(Modifier.padding(20.dp).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(10.dp)) {
        SelectionContainer {Text(state.selection!!.optString("text"))}
        state.records["highlights"].orEmpty().find {it.id==state.selection!!.optString("id")}?.let {quote->
            Row {TextButton(onClick={model.enableReview(quote,quote.value.isNull("review"))}){Text(if(quote.value.isNull("review"))"加入复习"else "移出复习")};TextButton(onClick={model.delete("highlights",listOf(quote));model.dismissSelection();onDismiss()}){Text("删除书摘")}}
        }
        TextButton(onClick={Sharing.text(context,"书籍选文",state.selection!!.optString("text"))}){Text("分享选文")}
        OutlinedTextField(note,{note=it},label={Text("批注")},modifier=Modifier.fillMaxWidth())
        Row(Modifier.horizontalScroll(rememberScrollState())) {for((id,label)in listOf("orange" to "橙","yellow" to "黄","green" to "绿","blue" to "蓝","purple" to "紫"))FilterChip(color==id,{color=id},label={Text(label)})}
        Row {for((id,label)in listOf("background" to "背景","underline" to "下划线","color" to "字色"))FilterChip(style==id,{style=id},label={Text(label)})}
        Button(onClick={model.saveSelection(note,style,color,onDismiss)}){Text("保存书摘")}
        Row {TextButton(onClick={citing=true}){Text("引用到笔记")};TextButton(onClick={model.outline("add",title=note.ifBlank {state.selection!!.optString("text").take(100)},target=state.selection);onDismiss()}){Text("加入目录")};if(state.associationSource==null)TextButton(onClick={model.beginAssociation();onDismiss()}){Text("关联此段")}
            else {TextButton(onClick={model.finishAssociation(note,"bidirectional");onDismiss()}){Text("保存双向关联")};TextButton(onClick={model.finishAssociation(note,"source-to-target");onDismiss()}){Text("保存单向关联")}}}
        Row {TextButton(onClick={val clipboard=context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager;clipboard.setPrimaryClip(android.content.ClipData.newPlainText("书房选文",state.selection!!.optString("text")));onDismiss()}){Text("复制")};TextButton(onClick={val engine=state.records["preferences"]?.find {it.id=="shufang:search-engine"}?.text("value")?:"google";context.startActivity(Intent(Intent.ACTION_VIEW,android.net.Uri.parse("https://www.$engine.com/search?q="+java.net.URLEncoder.encode(state.selection!!.optString("text"),"UTF-8"))))}){Text("搜索")};TextButton(onClick={model.openAi();model.ai("translate", "翻译所选文段为中文");onDismiss()}){Text("翻译")}}
        Row {TextButton(onClick={model.openAi();model.ai("studyCard","根据选文生成复习卡，返回包含 title、note、tags、cloze 的 JSON");onDismiss()}){Text("AI 制卡")};TextButton(onClick={model.openAi();model.ai("chat",note.ifBlank {"解释这段文字"});onDismiss()}){Text("AI 问答")}}
        Spacer(Modifier.height(32.dp))
    }}
    if(citing)AlertDialog(onDismissRequest={citing=false},title={Text("引用到笔记")},text={LazyColumn {items(state.records["notes"].orEmpty()){target->TextButton(onClick={model.citeSelection(target);citing=false;onDismiss()}){Text(target.text("title"))}}}},confirmButton={TextButton(onClick={citing=false}){Text("关闭")}})
}

@Composable private fun ReviewScreen(model:LibraryViewModel,state:LibraryState) {
    val card=state.review.firstOrNull();var answer by remember(card?.id){mutableStateOf(false)}
    var maskOriginal by rememberSaveable {mutableStateOf(false)};var editing by remember {mutableStateOf(false)};var historyLimit by rememberSaveable(state.reviewStudySet){mutableStateOf(100)}
    Column(Modifier.padding(20.dp).fillMaxSize().verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(16.dp)) {
        Text("待复习 ${state.review.size} 张",style=MaterialTheme.typography.headlineSmall)
        Row(Modifier.horizontalScroll(rememberScrollState()),horizontalArrangement=Arrangement.spacedBy(8.dp)) {
            FilterChip(state.reviewStudySet==null,{model.reviewQueue()},label={Text("全部学习卡片")})
            for(set in state.records["studySets"].orEmpty())FilterChip(state.reviewStudySet==set.id,{model.reviewQueue(set.id)},label={Text(set.text("title").ifBlank {set.text("name")})})
        }
        Row(verticalAlignment=Alignment.CenterVertically){Text("遮挡原文",Modifier.weight(1f));Switch(maskOriginal,{maskOriginal=it})}
        if(card==null)Text("本轮复习完成。可在书摘菜单中加入复习卡。")
        else {
            Text(card.text("name").ifBlank {card.text("chapterTitle")},style=MaterialTheme.typography.titleLarge)
            val cloze=card.value.optJSONArray("cloze")?:JSONArray();var text=card.text("text");if(!answer)repeat(cloze.length()){val word=cloze.optString(it);if(word.isNotBlank())text=text.replace(word,"［……］")}
            SelectionContainer{Text(if(maskOriginal&&!answer)"原文已遮挡"else text,style=MaterialTheme.typography.bodyLarge)}
            if(answer)Text(card.text("note"))else Button(onClick={answer=true}){Text("显示答案")}
            if(answer)Column(verticalArrangement=Arrangement.spacedBy(8.dp)){for(pair in listOf(listOf(0,1),listOf(2,3)))Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(8.dp)){for(index in pair)OutlinedButton(onClick={model.rate(card,index+1)},modifier=Modifier.weight(1f).heightIn(min=48.dp)){Text(listOf("重来","困难","良好","简单")[index])}}}
            TextButton(onClick={editing=true}){Text("编辑挖空")}
            TextButton(onClick={model.openBook(card.text("bookId"),card.value)}){Text("回到原文")}
        }
        HorizontalDivider();Text("复习历史",style=MaterialTheme.typography.titleMedium)
        val books=state.records["studySets"].orEmpty().find {it.id==state.reviewStudySet}?.value?.optJSONArray("bookIds")?.let {array->(0 until array.length()).map {array.getString(it)}.toSet()}
        val highlights=state.records["highlights"].orEmpty().associateBy {it.id}
        val history=state.records["reviews"].orEmpty().filter {event->val target=highlights[event.text("highlightId")];target!=null&&(books==null||target.text("bookId") in books)}.sortedByDescending {it.value.optLong("createdAt")}
        if(history.isEmpty())Text("还没有复习记录",color=MaterialTheme.colorScheme.onSurfaceVariant)
        for(event in history.take(historyLimit)){val quote=highlights[event.text("highlightId")]!!;val rating=event.value.optJSONObject("state")?.optInt("lastRating",0)?:0;TextButton(onClick={model.openBook(quote.text("bookId"),quote.value)}){Text("${SimpleDateFormat("MM-dd HH:mm",Locale.CHINA).format(Date(event.value.optLong("createdAt")))} · ${listOf("未评分","重来","困难","良好","简单").getOrElse(rating){"未评分"}} · ${quote.text("name").ifBlank {quote.text("text")}.take(40)}")}}
        if(history.size>historyLimit)TextButton(onClick={historyLimit+=100}){Text("更多复习记录")}
    }
    if(editing&&card!=null){var cloze by rememberSaveable(card.id){mutableStateOf(card.value.optJSONArray("cloze")?.let {array->(0 until array.length()).joinToString(","){array.optString(it)}}?:"")};AlertDialog(onDismissRequest={editing=false},title={Text("编辑挖空")},text={OutlinedTextField(cloze,{cloze=it},label={Text("挖空词，逗号分隔")})},confirmButton={TextButton(onClick={model.save("highlights",card,JSONObject().put("cloze",JSONArray(cloze.split(',').map {it.trim()}.filter {it.isNotEmpty()}))){editing=false;model.reviewQueue(state.reviewStudySet)}}){Text("保存")}},dismissButton={TextButton(onClick={editing=false}){Text("取消")}})}
}

@Composable private fun HistoryScreen(state:LibraryState,onBook:(String)->Unit) {
    val sessions=state.records["books"].orEmpty().flatMap {book->val array=book.value.optJSONArray("readingSessions")?:JSONArray();(0 until array.length()).map {book to array.getJSONObject(it)}}.sortedByDescending {it.second.optLong("startedAt")}
    LazyColumn(contentPadding=PaddingValues(16.dp)) {items(sessions) {(book,session)->ListItem(headlineContent={Text(book.text("title"))},supportingContent={Text("${SimpleDateFormat("yyyy-MM-dd HH:mm",Locale.CHINA).format(Date(session.optLong("startedAt")))} · ${(session.optLong("endedAt")-session.optLong("startedAt"))/60000} 分钟")},modifier=Modifier.clickable {onBook(book.id)})}}
}

@OptIn(ExperimentalLayoutApi::class)
@Composable private fun SettingsScreen(model:LibraryViewModel,state:LibraryState,importMode:String,onImportMode:(String)->Unit) {
    var origin by rememberSaveable {mutableStateOf(state.remote?.origin?:"")};var account by rememberSaveable {mutableStateOf(state.remote?.account?:"")};var password by remember {mutableStateOf("")}
    var newPassword by remember {mutableStateOf("")};var confirmPassword by remember {mutableStateOf("")}
    var authMode by rememberSaveable {mutableStateOf(state.remote?.mode?:"account")}
    val config=state.aiConfig.optJSONObject("value")?:JSONObject()
    var provider by remember(config.toString()){mutableStateOf(config.optString("provider","deepseek"))};var modelName by remember(config.toString()){mutableStateOf(config.optString("model"))};var effort by remember(config.toString()){mutableStateOf(config.optString("effort","none"))};var apiKey by remember {mutableStateOf("")};var question by rememberSaveable {mutableStateOf("")}
    var language by rememberSaveable {mutableStateOf("中文")}
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).imePadding().padding(20.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
        if(state.book!=null)TextButton(onClick={model.openBook(state.book.id)}){Text("返回阅读")}
        Row(verticalAlignment=Alignment.CenterVertically){Text("墨水屏模式",Modifier.weight(1f));Switch(state.inkMode,model::inkMode)}
        Text("连接现有书库",style=MaterialTheme.typography.titleLarge)
        state.routes?.let {group->SettingsGroup {Text("同一账号的连接地址",style=MaterialTheme.typography.titleMedium);TextButton(onClick={model.chooseRoute(null)}){Text(if(group.manual==null)"自动选路 · 已开启"else "使用自动选路")};for(address in group.addresses){val measurement=state.routeMeasurements.find {it.address==address};Row(verticalAlignment=Alignment.CenterVertically){TextButton(onClick={model.chooseRoute(address)},modifier=Modifier.weight(1f)){Text(address+"\n"+(measurement?.milliseconds?.let {"${it.toInt()} ms"}?:measurement?.error.orEmpty()))};if(address!=group.anchor&&address!=state.remote?.origin)TextButton(onClick={model.removeRoute(address)}){Text("移除")}}}}}

        SettingsGroup {
        Row {TextButton(onClick=model::syncNow){Text("立即同步")};TextButton(onClick=model::cancelSync){Text("取消当前同步")}}
        state.syncInfo?.let {info->Text("待发送元数据：${if(info.optBoolean("pendingAtLeast"))"至少 "else ""}${info.optInt("pendingMetadata")} 项\n原文件：${info.optInt("originals")-info.optInt("missingOriginals")} / ${info.optInt("originals")} 已就绪")}
        if(state.canRecoverMerge)TextButton(onClick=model::recoverOriginal){Text("返回合并前的本地书库")}
        Row {FilterChip(authMode=="account",{authMode="account"},label={Text("账号登录")});Spacer(Modifier.width(8.dp));FilterChip(authMode=="node",{authMode="node"},label={Text("高级节点令牌")})}
        OutlinedTextField(origin,{origin=it},label={Text("HTTPS 服务器地址")},modifier=Modifier.fillMaxWidth(),shape=MaterialTheme.shapes.small,colors=OutlinedTextFieldDefaults.colors(unfocusedBorderColor=Color.Transparent,unfocusedContainerColor=MaterialTheme.colorScheme.background,focusedContainerColor=MaterialTheme.colorScheme.background),singleLine=true)
        OutlinedTextField(account,{account=it},label={Text(if(authMode=="account")"账号"else "服务器节点 ID")},modifier=Modifier.fillMaxWidth(),shape=MaterialTheme.shapes.small,colors=OutlinedTextFieldDefaults.colors(unfocusedBorderColor=Color.Transparent,unfocusedContainerColor=MaterialTheme.colorScheme.background,focusedContainerColor=MaterialTheme.colorScheme.background),singleLine=true)
        OutlinedTextField(password,{password=it},label={Text(if(authMode=="account")"密码 / 修改时的当前密码"else "高级节点令牌")},visualTransformation=PasswordVisualTransformation(),modifier=Modifier.fillMaxWidth(),shape=MaterialTheme.shapes.small,colors=OutlinedTextFieldDefaults.colors(unfocusedBorderColor=Color.Transparent,unfocusedContainerColor=MaterialTheme.colorScheme.background,focusedContainerColor=MaterialTheme.colorScheme.background),singleLine=true)
        Row {Button(onClick={if(authMode=="node")model.connectNode(origin,account,password)else model.connect(origin,account,password);password=""}){Text("登录并连接")};TextButton(onClick=model::syncNow){Text("立即同步")};if(state.remote!=null)TextButton(onClick={model.logout()}){Text("退出登录")}}
        if(authMode=="node")Text("节点令牌采用独立认证，不使用账户会话。首次连接同样先预览整体合并。")
        Row(verticalAlignment=Alignment.CenterVertically){Switch(state.autoSync,model::autoSync);Text("前台编辑自动同步 · 后台按网络条件调度")}
        Text("后台同步由系统调度，至少 15 分钟周期；离线编辑会保留并在网络恢复后重试。",style=MaterialTheme.typography.bodySmall)
        StudyBackupPanel(model,state)
        SyncConflictPanel(model,state)
        if(state.conflictDrafts.isNotEmpty())SettingsGroup {
            Text("保留的冲突草稿",style=MaterialTheme.typography.titleMedium)
            Text("关闭弹窗或重新启动后，草稿仍可重新查看并选择保存。")
            state.conflictDrafts.forEachIndexed {index,path->TextButton(onClick={model.resumeConflictDraft(path)}){Text("打开草稿 ${index+1}")}}
        }
        if(authMode=="account") {
        if(state.remote?.mode=="account")TextButton(onClick={model.addAccountRoute(origin,account,password);password=""}){Text("验证并添加同账号地址")}
        OutlinedTextField(newPassword,{newPassword=it},label={Text("新密码")},visualTransformation=PasswordVisualTransformation(),modifier=Modifier.fillMaxWidth(),shape=MaterialTheme.shapes.small,colors=OutlinedTextFieldDefaults.colors(unfocusedBorderColor=Color.Transparent,unfocusedContainerColor=MaterialTheme.colorScheme.background,focusedContainerColor=MaterialTheme.colorScheme.background))
        OutlinedTextField(confirmPassword,{confirmPassword=it},label={Text("确认新密码")},visualTransformation=PasswordVisualTransformation(),modifier=Modifier.fillMaxWidth(),shape=MaterialTheme.shapes.small,colors=OutlinedTextFieldDefaults.colors(unfocusedBorderColor=Color.Transparent,unfocusedContainerColor=MaterialTheme.colorScheme.background,focusedContainerColor=MaterialTheme.colorScheme.background))
        Row {
            TextButton(onClick={model.remoteAction("/api/auth/setup","POST",JSONObject().put("username",account).put("newPassword",newPassword).put("confirmPassword",confirmPassword))}){Text("完成首次账户设置")}
            TextButton(onClick={model.remoteAction("/api/auth/profile","PATCH",JSONObject().put("username",account).put("currentPassword",password).put("newPassword",newPassword).put("confirmPassword",confirmPassword))}){Text("修改账户")}
        }
        }
        }
        Text("阅读与导入",style=MaterialTheme.typography.titleLarge)
        SettingsGroup {
        Row {FilterChip(selected=importMode=="reflow",onClick={onImportMode("reflow")},label={Text("PDF 重排")});Spacer(Modifier.width(8.dp));FilterChip(selected=importMode=="original",onClick={onImportMode("original")},label={Text("PDF 原版")})}
        Text("支持 PDF / EPUB / MOBI / AZW / AZW3 / FB2 / TXT。TXT 上限 64 MiB，其余格式 128 MiB。")
        val engine=state.records["preferences"]?.find {it.id=="shufang:search-engine"}?.text("value")?:"google"
        Row {for((id,label)in listOf("google" to "Google 搜索","bing" to "Bing 搜索"))FilterChip(engine==id,{model.preference("shufang:search-engine",id)},label={Text(label)},modifier=Modifier.padding(end=8.dp))}
        }
        Text("AI 阅读助手",style=MaterialTheme.typography.titleLarge)
        SettingsGroup {
        Row(Modifier.horizontalScroll(rememberScrollState())){for(id in listOf("deepseek","openai","kimi","minimax","codex"))FilterChip(selected=provider==id,onClick={provider=id},label={Text(id)},modifier=Modifier.padding(end=8.dp))}
        OutlinedTextField(modelName,{modelName=it},label={Text("模型")},modifier=Modifier.fillMaxWidth(),shape=MaterialTheme.shapes.small,colors=OutlinedTextFieldDefaults.colors(unfocusedBorderColor=Color.Transparent,unfocusedContainerColor=MaterialTheme.colorScheme.background,focusedContainerColor=MaterialTheme.colorScheme.background))
        if(state.aiModels.isNotEmpty())FlowRow {for(name in state.aiModels)FilterChip(modelName==name,{modelName=name},label={Text(name)},modifier=Modifier.padding(end=6.dp))}
        OutlinedTextField(effort,{effort=it},label={Text("思考强度：none / low / medium / high / xhigh / max")},modifier=Modifier.fillMaxWidth(),shape=MaterialTheme.shapes.small,colors=OutlinedTextFieldDefaults.colors(unfocusedBorderColor=Color.Transparent,unfocusedContainerColor=MaterialTheme.colorScheme.background,focusedContainerColor=MaterialTheme.colorScheme.background))
        if(provider!="codex")OutlinedTextField(apiKey,{apiKey=it},label={Text("Provider API Key · Android Keystore 保护")},visualTransformation=PasswordVisualTransformation(),modifier=Modifier.fillMaxWidth(),shape=MaterialTheme.shapes.small,colors=OutlinedTextFieldDefaults.colors(unfocusedBorderColor=Color.Transparent,unfocusedContainerColor=MaterialTheme.colorScheme.background,focusedContainerColor=MaterialTheme.colorScheme.background))
        Button(onClick={model.configureAi(JSONObject().put("provider",provider).put("model",modelName).put("effort",effort),apiKey);apiKey=""}){Text("保存 AI 配置")}
        OutlinedTextField(question,{question=it},label={Text("问题 / 生成要求")},modifier=Modifier.fillMaxWidth(),shape=MaterialTheme.shapes.small,colors=OutlinedTextFieldDefaults.colors(unfocusedBorderColor=Color.Transparent,unfocusedContainerColor=MaterialTheme.colorScheme.background,focusedContainerColor=MaterialTheme.colorScheme.background),minLines=3)
        OutlinedTextField(language,{language=it},label={Text("翻译目标语言")},modifier=Modifier.fillMaxWidth(),shape=MaterialTheme.shapes.small,colors=OutlinedTextFieldDefaults.colors(unfocusedBorderColor=Color.Transparent,unfocusedContainerColor=MaterialTheme.colorScheme.background,focusedContainerColor=MaterialTheme.colorScheme.background))
        FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)){for((task,label)in listOf("chat" to "对话","translate" to "翻译","mindMap" to "生成脑图","studyCard" to "生成卡片","digest" to "全书导读","test" to "测试连接","models" to "模型列表"))OutlinedButton(onClick={model.ai(task,question,language)}){Text(label)}}
        TextButton(onClick=model::cancelAi){Text("取消 AI 等待")}
        if(state.aiMessages.length()>0){Text("当前对话 ${state.aiMessages.length()/2} 轮");TextButton(onClick=model::clearConversation){Text("新建对话")}}
        if(state.aiResult.isNotEmpty()){SelectionContainer{Text(state.aiResult)};Button(onClick=model::saveAi){Text("保存到书库")}}
        }
        Text("远端服务器管理",style=MaterialTheme.typography.titleLarge)
        SettingsGroup {
        Text("以下操作作用于已连接的服务器。")
        FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
            TextButton(onClick={model.remoteAction("/api/autostart/status")}){Text("服务器自启状态")}
            if(state.serverStartup?.optBoolean("supported")==true&&state.serverStartup.optBoolean("installed")) {
                TextButton(onClick={model.remoteAction("/api/autostart/status","POST",JSONObject().put("enabled",true))}){Text("启用服务器自启")}
                TextButton(onClick={model.remoteAction("/api/autostart/status","POST",JSONObject().put("enabled",false))}){Text("关闭服务器自启")}
            }
            TextButton(onClick={model.remoteAction("/api/auth/codex/status")}){Text("Codex 登录状态")}
            if(state.serverCodex?.optBoolean("available")==true) {
                TextButton(onClick={model.remoteAction("/api/auth/codex/login","POST",JSONObject())}){Text("服务器 Codex 登录")}
                TextButton(onClick={model.remoteAction("/api/auth/codex/logout","POST",JSONObject())}){Text("服务器 Codex 退出")}
            }
        }
        }
        Text("書房 Android ${BuildConfig.VERSION_NAME} · Rust C ABI 1",style=MaterialTheme.typography.labelSmall)
        Spacer(Modifier.height(50.dp))
    }
}

@Composable private fun SettingsGroup(content:@Composable ColumnScope.()->Unit) {
    Card(Modifier.fillMaxWidth(),shape=RoundedCornerShape(16.dp),border=BorderStroke(1.dp,MaterialTheme.colorScheme.outlineVariant.copy(alpha=.5f)),colors=CardDefaults.cardColors(containerColor=MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp),content=content)
    }
}
