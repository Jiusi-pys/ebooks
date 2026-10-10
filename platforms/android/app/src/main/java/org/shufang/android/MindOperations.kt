package org.shufang.android

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

fun mindFromBook(book:Record):JSONObject {
    fun node(text:String)=JSONObject().put("id",UUID.randomUUID().toString()).put("text",text).put("children",JSONArray())
    val chapters=book.value.optJSONArray("chapters")?:JSONArray()
    val children=JSONArray()
    repeat(chapters.length()) {index->
        val chapter=chapters.getJSONObject(index);val paragraphs=chapter.optJSONArray("paragraphs")?:JSONArray()
        val hints=JSONArray()
        repeat(minOf(3,paragraphs.length())) {i->val text=paragraphs.optString(i).trim().replace(Regex("\\s+")," ");hints.put(node(if(text.isEmpty())"段落 ${i+1}"else AiContext.prefix(text,26)+if(text.length>26)"…"else ""))}
        children.put(node("${(index+1).toString().padStart(2,'0')} ${chapter.optString("title")}").put("chapterId",chapter.getString("id")).put("collapsed",paragraphs.length()>1).put("children",hints))
    }
    return node(book.text("title")).put("children",children)
}
fun findMindNode(root:JSONObject,id:String,depth:Int=0):JSONObject? {
    if(root.optString("id")==id)return root
    if(depth>=64)return null
    val children=root.optJSONArray("children")?:return null
    repeat(children.length()){findMindNode(children.getJSONObject(it),id,depth+1)?.let {node->return node}}
    return null
}
fun replaceMindNode(root:JSONObject,id:String,replacement:JSONObject,depth:Int=0):JSONObject {
    if(root.optString("id")==id)return replacement
    if(depth>=64)return root
    val children=root.optJSONArray("children")?:return root
    return JSONObject(root.toString()).put("children",JSONArray((0 until children.length()).map {replaceMindNode(children.getJSONObject(it),id,replacement,depth+1)}))
}
fun mindNodes(root:JSONObject,depth:Int=0):List<JSONObject> {
    if(depth>=64)return listOf(root)
    val children=root.optJSONArray("children")?:JSONArray()
    return listOf(root)+(0 until children.length()).flatMap {mindNodes(children.getJSONObject(it),depth+1)}
}

/** Move an entire subtree. The position is measured after removing the source. */
fun moveMindNode(root:JSONObject,sourceId:String,parentId:String,position:Int):JSONObject {
    val ids=mutableSetOf<String>()
    fun validate(node:JSONObject,depth:Int) {
        require(depth<=64){"脑图层级过深"}
        val id=node.optString("id")
        require(id.isNotBlank()&&ids.add(id)){"脑图节点身份重复或缺失"}
        val children=node.optJSONArray("children")?:JSONArray()
        repeat(children.length()){validate(children.getJSONObject(it),depth+1)}
    }
    validate(root,0)
    require(sourceId!=root.getString("id")){"中心主题不能移动"}
    val source=requireNotNull(findMindNode(root,sourceId)){"移动节点不存在"}
    require(findMindNode(root,parentId)!=null){"目标节点不存在"}
    require(findMindNode(source,parentId)==null){"不能移动到自身或子节点"}
    fun remove(node:JSONObject):JSONObject {
        val children=node.optJSONArray("children")?:JSONArray()
        return JSONObject(node.toString()).put("children",JSONArray((0 until children.length()).map {children.getJSONObject(it)}.filter {it.getString("id")!=sourceId}.map(::remove)))
    }
    val detached=remove(root)
    val parent=findMindNode(detached,parentId)!!
    val children=parent.optJSONArray("children")?:JSONArray()
    require(position in 0..children.length()){ "目标位置无效" }
    val next=(0 until children.length()).map {children.getJSONObject(it)}.toMutableList()
    next.add(position,JSONObject(source.toString()))
    val moved=replaceMindNode(detached,parentId,JSONObject(parent.toString()).put("children",JSONArray(next)).put("collapsed",false))
    ids.clear()
    validate(moved,0)
    return moved
}
