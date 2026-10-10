package org.shufang.android

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.toSize
import org.json.JSONObject

/** Native, scrollable tree. Node focus feeds the same editor and save operation. */
@Composable fun MindCanvas(root:JSONObject,selected:String,onFocus:(String)->Unit) {
    val bounds=remember(root.toString()){mutableStateMapOf<String,Rect>()}
    var origin by remember {mutableStateOf(Offset.Zero)}
    val lineColor=MaterialTheme.colorScheme.outline
    val links=mutableListOf<Pair<String,String>>()
    fun collect(node:JSONObject,depth:Int=0) {
        if(depth>=64||node.optBoolean("collapsed"))return
        val children=node.optJSONArray("children")?:return
        repeat(children.length()) {index->val child=children.getJSONObject(index);links.add(node.getString("id") to child.getString("id"));collect(child,depth+1)}
    }
    collect(root)
    Box(Modifier.fillMaxWidth().heightIn(min=180.dp,max=360.dp).testTag("mind-canvas").horizontalScroll(rememberScrollState()).verticalScroll(rememberScrollState())) {
        Box(Modifier.onGloballyPositioned {origin=it.positionInRoot()}.drawBehind {
            for((parent,child)in links) {
                val from=bounds[parent]?:continue;val to=bounds[child]?:continue
                val start=Offset(from.right,from.center.y)-origin
                val end=Offset(to.left,to.center.y)-origin
                val middle=(start.x+end.x)/2
                drawPath(Path().apply {moveTo(start.x,start.y);lineTo(middle,start.y);lineTo(middle,end.y);lineTo(end.x,end.y)},lineColor,style=androidx.compose.ui.graphics.drawscope.Stroke(2.dp.toPx()))
            }
        }.padding(12.dp)) {
            MindCanvasBranch(root,selected,onFocus,bounds,0)
        }
    }
}

@Composable private fun MindCanvasBranch(node:JSONObject,selected:String,onFocus:(String)->Unit,bounds:MutableMap<String,Rect>,depth:Int) {
    if(depth>64)return
    val id=node.getString("id")
    Row(verticalAlignment=Alignment.CenterVertically) {
        OutlinedCard(onClick={onFocus(id)},modifier=Modifier.width(180.dp).testTag("mind-canvas-$id").onGloballyPositioned {coordinates->val rect=Rect(coordinates.positionInRoot(),coordinates.size.toSize());if(bounds[id]!=rect)bounds[id]=rect},colors=CardDefaults.outlinedCardColors(containerColor=if(id==selected)MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface)) {
            Column(Modifier.padding(12.dp).heightIn(min=48.dp)) {
                Text(node.optString("text").ifBlank {"未命名节点"},style=MaterialTheme.typography.bodyMedium)
                if(node.has("sourceHighlightId"))Text("书摘引用",style=MaterialTheme.typography.labelSmall)
                if(node.optBoolean("collapsed"))Text("已折叠",style=MaterialTheme.typography.labelSmall)
            }
        }
        val children=node.optJSONArray("children")
        if(!node.optBoolean("collapsed")&&children!=null&&children.length()>0) {
            Spacer(Modifier.width(40.dp))
            Column(verticalArrangement=Arrangement.spacedBy(20.dp)) {
                repeat(children.length()){index->val child=children.getJSONObject(index);key(child.getString("id")){MindCanvasBranch(child,selected,onFocus,bounds,depth+1)}}
            }
        }
    }
}
