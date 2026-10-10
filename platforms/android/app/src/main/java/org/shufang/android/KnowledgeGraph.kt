package org.shufang.android

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp

data class GraphNode(val kind:String,val record:Record) {val key get()="$kind:${record.id}"}
data class KnowledgeGraph(val nodes:List<GraphNode>,val edges:Set<Pair<String,String>>)

fun knowledgeGraph(records:Map<String,List<Record>>):KnowledgeGraph {
    val kinds=listOf("books","notes","highlights","mindMaps")
    val nodes=kinds.flatMap {kind->records[kind].orEmpty().map {GraphNode(kind,it)}}
    val keys=nodes.map {it.key}.toSet();val edges=linkedSetOf<Pair<String,String>>()
    fun link(a:String,b:String) {if(a!=b&&a in keys&&b in keys)edges+=if(a<b)a to b else b to a}
    for(node in nodes) {
        val record=node.record
        link(node.key,"books:${record.text("bookId")}")
        link(node.key,"notes:${record.text("noteId")}")
        if(node.kind=="notes")Regex("\\[\\[([^]\\n]+)]]").findAll(record.text("content")).forEach {match->
            nodes.filter {it.kind in listOf("books","notes")&&it.record.text("title")==match.groupValues[1]}.forEach {link(node.key,it.key)}
        }
        if(node.kind=="mindMaps") {
            fun visit(value:org.json.JSONObject?,depth:Int) {
                if(value==null||depth>64)return
                link(node.key,"highlights:${value.optString("sourceHighlightId")}")
                val children=value.optJSONArray("children")?:return
                repeat(children.length()){visit(children.optJSONObject(it),depth+1)}
            };visit(record.value.optJSONObject("root"),0)
        }
    }
    records["associations"].orEmpty().forEach {record->
        val source=record.value.optJSONObject("source");val target=record.value.optJSONObject("target")
        link("books:${source?.optString("bookId")}","books:${target?.optString("bookId")}")
    }
    return KnowledgeGraph(nodes,edges)
}

@Composable fun KnowledgeGraphScreen(state:LibraryState,onEntity:(String,String)->Unit) {
    val graph=remember(state.records){knowledgeGraph(state.records)}
    val names=mapOf("books" to "书籍","notes" to "笔记","highlights" to "书摘","mindMaps" to "脑图")
    var kinds by remember {mutableStateOf(names.keys)}
    var zoom by remember {mutableFloatStateOf(1f)};var pan by remember {mutableStateOf(Offset.Zero)}
    val nodes=graph.nodes.filter {it.kind in kinds}
    val points=remember(nodes){nodes.mapIndexed {index,_->val angle=index*2*Math.PI/nodes.size.coerceAtLeast(1);Offset(Math.cos(angle).toFloat()*.38f,Math.sin(angle).toFloat()*.38f)}}
    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Text("${graph.nodes.size} 个节点 · ${graph.edges.size} 条关联",style=MaterialTheme.typography.titleMedium)
        Row(Modifier.horizontalScroll(rememberScrollState())) {names.forEach {(kind,label)->FilterChip(kind in kinds,{kinds=if(kind in kinds)kinds-kind else kinds+kind},label={Text(label)})}}
        Row {TextButton(onClick={zoom=(zoom/1.3f).coerceAtLeast(.3f)}){Text("缩小")};TextButton(onClick={zoom=(zoom*1.3f).coerceAtMost(5f)}){Text("放大")};TextButton(onClick={zoom=1f;pan=Offset.Zero}){Text("复位视图")}}
        Text("双指缩放、拖动平移，点击节点或列表打开内容",style=MaterialTheme.typography.bodySmall)
        Canvas(Modifier.fillMaxWidth().height(240.dp)
            .pointerInput(nodes,zoom,pan){detectTapGestures {tap->
                val at=points.map {Offset(size.width/2f+it.x*size.width*zoom,size.height/2f+it.y*size.height*zoom)+pan}
                at.withIndex().minByOrNull {(it.value-tap).getDistance()}?.takeIf {(it.value-tap).getDistance()<32.dp.toPx()}?.let {onEntity(nodes[it.index].kind,nodes[it.index].record.id)}
            }}
            .pointerInput(Unit){detectTransformGestures {_,translation,scale,_->pan+=translation;zoom=(zoom*scale).coerceIn(.3f,5f)}}) {
            val at=points.map {Offset(size.width/2+it.x*size.width*zoom,size.height/2+it.y*size.height*zoom)+pan}
            val positions=nodes.mapIndexed {i,node->node.key to at[i]}.toMap()
            graph.edges.forEach {(a,b)->val start=positions[a];val end=positions[b];if(start!=null&&end!=null)drawLine(Color(0xFF91A38A),start,end,2f)}
            nodes.forEachIndexed {i,node->drawCircle(when(node.kind){"books"->Color(0xFF527B4E);"notes"->Color(0xFF5177A0);"mindMaps"->Color(0xFF8B68A2);else->Color(0xFFB58A4E)},7.dp.toPx(),at[i])}
        }
        LazyColumn(Modifier.weight(1f)) {items(nodes,key={it.key}) {node->ListItem(headlineContent={Text(node.record.text("title").ifBlank {node.record.text("text").take(60)})},supportingContent={Text(names[node.kind].orEmpty())},modifier=Modifier.clickable {onEntity(node.kind,node.record.id)})}}
    }
}
