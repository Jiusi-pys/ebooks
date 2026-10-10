package org.shufang.android

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

@Composable fun MindMoveMenu(root:JSONObject,nodeId:String,onChange:(JSONObject)->Unit) {
    var open by remember(nodeId){mutableStateOf(false)}
    var error by remember(nodeId){mutableStateOf("")}
    if(nodeId==root.optString("id"))return
    TextButton(onClick={open=true;error=""}){Text("移动到其他节点")}
    if(open) {
        val source=findMindNode(root,nodeId)
        val excluded=source?.let {mindNodes(it).map {node->node.optString("id")}.toSet()}.orEmpty()
        AlertDialog(onDismissRequest={open=false},title={Text("选择新的父节点")},text={Column {
            Text("保留子节点与书摘引用，移动到所选节点的末尾。")
            if(error.isNotBlank())Text(error,color=MaterialTheme.colorScheme.error)
            LazyColumn(Modifier.heightIn(max=360.dp)) {items(mindNodes(root).filter {it.optString("id") !in excluded},key={it.getString("id")}) {target->
                TextButton(onClick={try {
                    val children=target.optJSONArray("children")?:JSONArray()
                    val remaining=(0 until children.length()).count {children.getJSONObject(it).optString("id")!=nodeId}
                    onChange(moveMindNode(root,nodeId,target.getString("id"),remaining));open=false
                }catch(reason:IllegalArgumentException){error=reason.message.orEmpty()}},modifier=Modifier.fillMaxWidth()) {Text(target.optString("text").ifBlank {"未命名节点"})}
            }}
        }},confirmButton={TextButton(onClick={open=false}){Text("取消")}})
    }
}

@Composable fun MetadataFields(metadata:JSONObject,onChange:(JSONObject)->Unit) {
    fun change(key:String,value:Any?) {onChange(JSONObject(metadata.toString()).put("version",1).apply {if(value==null)remove(key)else put(key,value)})}
    for((key,label) in listOf("subtitle" to "副标题","publisher" to "出版社","publishedDate" to "出版日期","series" to "丛书","description" to "简介","edition" to "版次","rights" to "版权")) {
        OutlinedTextField(metadata.optString(key),{change(key,it)},label={Text(label)},modifier=Modifier.fillMaxWidth(),minLines=if(key=="description")3 else 1)
    }
    for((key,label) in listOf("languages" to "语言，逗号分隔","subjects" to "主题，逗号分隔")) {
        val array=metadata.optJSONArray(key)?:JSONArray()
        OutlinedTextField((0 until array.length()).joinToString(","){array.optString(it)},{change(key,JSONArray(it.split(',').map(String::trim).filter(String::isNotBlank)))},label={Text(label)},modifier=Modifier.fillMaxWidth())
    }
    for((key,label) in listOf("seriesIndex" to "丛书序号","rating" to "评分 0–5")) {
        var draft by remember {mutableStateOf(metadata.opt(key)?.toString().orEmpty())}
        OutlinedTextField(draft,{draft=it;if(it.isBlank())change(key,null)else it.toDoubleOrNull()?.let {number->change(key,number)}},label={Text(label)},modifier=Modifier.fillMaxWidth())
    }
    for((role,label) in listOf("author" to "作者","editor" to "编者","translator" to "译者","illustrator" to "插画者","other" to "其他贡献者")) {
        val array=metadata.optJSONArray("contributors")?:JSONArray();val people=(0 until array.length()).map {array.getJSONObject(it)}
        var draft by remember {mutableStateOf(people.filter {it.optString("role")==role}.joinToString("；"){it.optString("name")})}
        OutlinedTextField(draft,{draft=it;change("contributors",JSONArray(people.filter {p->p.optString("role")!=role}+it.split('；',';').filter(String::isNotBlank).map {name->JSONObject().put("role",role).put("name",name.trim())}))},label={Text("$label（多人用分号分隔）")},modifier=Modifier.fillMaxWidth())
    }
    val identifiers=metadata.optJSONArray("identifiers")?:JSONArray()
    var ids by remember {mutableStateOf((0 until identifiers.length()).joinToString("\n"){identifiers.getJSONObject(it).let {id->id.optString("scheme")+": "+id.optString("value")}})}
    OutlinedTextField(ids,{ids=it;change("identifiers",JSONArray(it.lines().filter {line->line.contains(':')}.map {line->JSONObject().put("scheme",line.substringBefore(':').trim()).put("value",line.substringAfter(':').trim())}))},label={Text("ISBN / DOI / ASIN / 其他编号（每行 类型: 编号）")},modifier=Modifier.fillMaxWidth(),minLines=3)
}

@Composable fun MindNodeEditor(node:JSONObject,highlights:List<Record>,onChange:(JSONObject)->Unit,depth:Int=0,onPromote:((JSONObject)->Unit)?=null,onSource:((Record)->Unit)?=null) {
    if(depth>64)return
    var pick by remember {mutableStateOf(false)}
    val children=node.optJSONArray("children")?:JSONArray()
    fun replaceChildren(next:List<JSONObject>){onChange(JSONObject(node.toString()).put("children",JSONArray(next)))}
    Column(Modifier.padding(start=if(depth==0)0.dp else 12.dp).fillMaxWidth()) {
        OutlinedTextField(node.optString("text"),{onChange(JSONObject(node.toString()).put("text",it))},label={Text(if(depth==0)"中心主题"else "节点内容")},modifier=Modifier.fillMaxWidth())
        Row(Modifier.horizontalScroll(rememberScrollState())) {
            TextButton(onClick={replaceChildren((0 until children.length()).map {children.getJSONObject(it)}+JSONObject().put("id",UUID.randomUUID().toString()).put("text","新节点").put("children",JSONArray()))}){Text("添加子节点")}
            TextButton(onClick={onChange(JSONObject(node.toString()).put("collapsed",!node.optBoolean("collapsed")))}){Text(if(node.optBoolean("collapsed"))"展开"else "折叠")}
            TextButton(onClick={pick=true}){Text("关联书摘")}
            if(node.has("sourceHighlightId"))TextButton(onClick={onChange(JSONObject(node.toString()).apply {remove("sourceHighlightId")})}){Text("移除引用")}
            highlights.find {it.id==node.optString("sourceHighlightId")}?.let {quote->if(onSource!=null)TextButton(onClick={onSource(quote)}){Text("跳转原文")}}
        }
        if(!node.optBoolean("collapsed"))repeat(children.length()) {index->
            key(children.getJSONObject(index).optString("id")) {
                MindNodeEditor(children.getJSONObject(index),highlights,{child->replaceChildren((0 until children.length()).map {if(it==index)child else children.getJSONObject(it)})},depth+1,{promoted->
                    val parent=JSONObject(children.getJSONObject(index).toString());val nested=parent.optJSONArray("children")?:JSONArray()
                    parent.put("children",JSONArray((0 until nested.length()).map {nested.getJSONObject(it)}.filter {it.optString("id")!=promoted.optString("id")}))
                    val list=(0 until children.length()).map {if(it==index)parent else children.getJSONObject(it)}.toMutableList();list.add(index+1,promoted);replaceChildren(list)
                },onSource)
                Row {
                    TextButton(onClick={replaceChildren((0 until children.length()).filter {it!=index}.map {children.getJSONObject(it)})}){Text("删除节点")}
                    if(index>0)TextButton(onClick={val list=(0 until children.length()).map {children.getJSONObject(it)}.toMutableList();java.util.Collections.swap(list,index,index-1);replaceChildren(list)}){Text("上移")}
                    if(index<children.length()-1)TextButton(onClick={val list=(0 until children.length()).map {children.getJSONObject(it)}.toMutableList();java.util.Collections.swap(list,index,index+1);replaceChildren(list)}){Text("下移")}
                    if(index>0)TextButton(onClick={val list=(0 until children.length()).map {children.getJSONObject(it)}.toMutableList();val parent=JSONObject(list[index-1].toString());val nested=parent.optJSONArray("children")?:JSONArray();nested.put(list.removeAt(index));parent.put("children",nested);list[index-1]=parent;replaceChildren(list)}){Text("缩进")}
                    if(onPromote!=null)TextButton(onClick={onPromote(children.getJSONObject(index))}){Text("提升")}
                }
            }
        }
    }
    if(pick)AlertDialog(onDismissRequest={pick=false},title={Text("关联书摘")},text={LazyColumn {items(highlights){highlight->TextButton(onClick={onChange(JSONObject(node.toString()).put("sourceHighlightId",highlight.id).put("chapterId",highlight.text("chapterId")));pick=false}){Text(highlight.text("text").take(80))}}}},confirmButton={TextButton(onClick={pick=false}){Text("关闭")}})
}

@Composable fun SearchScreen(model:LibraryViewModel,state:LibraryState,onEdit:(String,Record)->Unit) {
    var query by remember {mutableStateOf("")};var kind by remember {mutableStateOf("all")};var scope by remember {mutableStateOf("all")};var setId by remember {mutableStateOf("")}
    val books=when(scope){"book"->state.book?.let {listOf(it.id)}?:emptyList();"set"->state.records["studySets"]?.find {it.id==setId}?.value?.optJSONArray("bookIds")?.let {array->(0 until array.length()).map {array.getString(it)}}?:emptyList();else->null}
    LaunchedEffect(query,kind,scope,setId) {kotlinx.coroutines.delay(300);model.search(query,kind,books)}
    Column(Modifier.fillMaxSize().padding(12.dp)) {
        OutlinedTextField(query,{query=it},label={Text("搜索全书正文、笔记、书摘与标签")},modifier=Modifier.fillMaxWidth(),singleLine=true)
        Row(Modifier.horizontalScroll(rememberScrollState())){for((id,label)in listOf("all" to "全部书库","book" to "当前书籍","set" to "学习集"))FilterChip(scope==id,{scope=id},label={Text(label)},modifier=Modifier.padding(end=8.dp))}
        if(scope=="set")Row(Modifier.horizontalScroll(rememberScrollState())){for(set in state.records["studySets"].orEmpty())FilterChip(setId==set.id,{setId=set.id},label={Text(set.text("name"))},modifier=Modifier.padding(end=8.dp))}
        Row(Modifier.horizontalScroll(rememberScrollState())){for((id,label)in listOf("all" to "所有类型","books" to "书籍","content" to "正文","notes" to "笔记","highlights" to "书摘"))FilterChip(kind==id,{kind=id},label={Text(label)},modifier=Modifier.padding(end=8.dp))}
        Text("${state.searchTotal} 项匹配结果",style=MaterialTheme.typography.labelMedium)
        if(state.searchTruncated)Text("当前显示前 500 项，可缩小搜索范围。",style=MaterialTheme.typography.labelSmall)
        if(query.isNotBlank() && state.searchComplete && kind in listOf("all","content"))key(state.searchToken){PdfSearchView(model,state,query,books)}
        for(warning in state.searchWarnings)Text(warning,style=MaterialTheme.typography.labelSmall)
        LazyColumn {items(state.searchResults){hit->val record=Record.from(hit.getJSONObject("record"));val type=hit.getString("kind")
            ListItem(headlineContent={Text(record.text("title").ifBlank {record.text("text").take(80)})},supportingContent={Text(hit.optString("preview").ifBlank {record.text("content").take(180)})},modifier=Modifier.clickable {
                if(type=="books")model.openBook(record.id,hit.optJSONObject("anchor"))else if(type=="highlights")model.openBook(record.text("bookId"),record.value)
                else model.perform("打开搜索结果"){onEdit(type,model.repository.get(type,record.id))}
            })
        };if(state.searchNext!=null)item {TextButton(onClick=model::moreSearch,enabled=state.busy.isEmpty()){Text("加载更多结果")}}}
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun TypePanel(settings:JSONObject,onDismiss:()->Unit,onSave:(JSONObject)->Unit,general:JSONObject=JSONObject(),onGeneral:((JSONObject)->Unit)?=null,onReset:(()->Unit)?=null) {
    var value by remember {mutableStateOf(JSONObject(settings.toString()))}
    var scope by remember {mutableStateOf("book")}
    fun change(key:String,next:Any){value=JSONObject(value.toString()).put(key,next)}
    ModalBottomSheet(onDismissRequest=onDismiss) {Column(Modifier.verticalScroll(rememberScrollState()).padding(20.dp)) {
        Text("阅读排版",style=MaterialTheme.typography.titleLarge)
        if(onGeneral!=null)Row {FilterChip(scope=="book",{scope="book";value=JSONObject(settings.toString())},label={Text("本书")});FilterChip(scope=="general",{scope="general";value=JSONObject(general.toString())},label={Text("通用")})}
        for((key,label,min,max,default)in listOf(TypeRange("fontSize","字号",12f,36f,19f),TypeRange("lineHeight","行距",1.4f,2.6f,2f),TypeRange("paragraphSpacing","段间距",0f,3f,.4f),TypeRange("letterSpacing","字距",0f,.12f,.02f),TypeRange("readingWidthPercent","正文宽度 %",50f,100f,92f))) {
            Text("$label：${"%.2f".format(value.optDouble(key,default.toDouble()))}")
            Slider(value.optDouble(key,default.toDouble()).toFloat().coerceIn(min,max),{change(key,it)},valueRange=min..max)
        }
        for((key,options)in listOf("fontId" to listOf("song" to "宋体","hei" to "黑体","kai" to "楷体","fangsong" to "仿宋","yuan" to "圆体","xihei" to "细黑","latin-serif" to "西文衬线","latin-sans" to "西文无衬线"),"themeId" to listOf("paper" to "纸白","warm" to "暖米","green" to "豆绿","night" to "夜览"),"readingFlow" to listOf("horizontal" to "左右分页","vertical" to "上下分页","scroll" to "上下滚动"),"pageEffect" to listOf("slide" to "平移","fade" to "淡入淡出","none" to "无动画"))) {
            Row(Modifier.horizontalScroll(rememberScrollState())){for((id,label)in options)FilterChip(value.optString(key)==id,{change(key,id)},label={Text(label)},modifier=Modifier.padding(end=8.dp))}
        }
        Row {for(weight in listOf(300,400,600))FilterChip(value.optInt("fontWeight",400)==weight,{change("fontWeight",weight)},label={Text("字重 $weight")});for(columns in 1..2)FilterChip(value.optInt("columns",1)==columns,{change("columns",columns)},label={Text("$columns 栏")})}
        Button(onClick={if(scope=="general")onGeneral?.invoke(value)else onSave(value);onDismiss()}){Text(if(scope=="general")"保存通用排版"else "保存本书排版")}
        if(onReset!=null)TextButton(onClick={onReset();onDismiss()}){Text("本书恢复使用通用排版")}
        Spacer(Modifier.height(28.dp))
    }}
}
private data class TypeRange(val key:String,val label:String,val min:Float,val max:Float,val default:Float)
