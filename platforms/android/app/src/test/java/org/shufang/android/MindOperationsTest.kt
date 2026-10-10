package org.shufang.android

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class MindOperationsTest {
    private fun node(id:String,vararg children:JSONObject)=JSONObject().put("id",id).put("text",id).put("children",JSONArray(children.toList()))

    @Test fun movingSubtreePreservesCardIdentityAndDoesNotMutateDraft() {
        val card=node("card").put("sourceHighlightId","same-card").put("chapterId","chapter")
        val root=node("root",node("one",card,node("sibling")),node("two"))
        val original=root.toString()
        val moved=moveMindNode(root,"card","two",0)
        assertEquals(original,root.toString())
        assertEquals(listOf("sibling"),mindNodes(findMindNode(moved,"one")!!).drop(1).map {it.getString("id")})
        assertEquals("card",findMindNode(moved,"two")!!.getJSONArray("children").getJSONObject(0).getString("id"))
        assertEquals("same-card",findMindNode(moved,"card")!!.getString("sourceHighlightId"))
        assertEquals("chapter",findMindNode(moved,"card")!!.getString("chapterId"))
        val reordered=moveMindNode(root,"sibling","one",0)
        assertEquals("sibling",findMindNode(reordered,"one")!!.getJSONArray("children").getJSONObject(0).getString("id"))
    }

    @Test fun movingRejectsCyclesMissingNodesRootAndOutOfRangePositions() {
        val root=node("root",node("one",node("child")),node("two"))
        for((source,target,index) in listOf(Triple("one","child",0),Triple("one","one",0),Triple("root","two",0),Triple("missing","two",0),Triple("one","missing",0),Triple("one","two",-1),Triple("one","two",2))) {
            assertThrows(IllegalArgumentException::class.java){moveMindNode(root,source,target,index)}
        }
        val duplicate=node("root",node("one"),node("one"))
        assertThrows(IllegalArgumentException::class.java){moveMindNode(duplicate,"one","root",0)}
    }

    @Test fun movingSupportsTheCoreDepthBoundaryAndRejectsDeeperTrees() {
        var root=node("64")
        for(depth in 63 downTo 0)root=node(depth.toString(),root)
        val moved=moveMindNode(root,"64","0",1)
        assertEquals("64",moved.getJSONArray("children").getJSONObject(1).getString("id"))
        val tooDeep=node("extra",root)
        assertThrows(IllegalArgumentException::class.java){moveMindNode(tooDeep,"64","extra",1)}
    }
    @Test fun bookOutlineMindKeepsChapterLinksAndEditingPreservesSiblings() {
        val book=Record(1,JSONObject().put("id","book").put("title","书籍").put("chapters",JSONArray().put(JSONObject().put("id","one").put("title","第一章").put("paragraphs",JSONArray().put("正文 🚀").put("第二段")))))
        val root=mindFromBook(book)
        val chapter=root.getJSONArray("children").getJSONObject(0)
        assertEquals("one",chapter.getString("chapterId"));assertTrue(chapter.getBoolean("collapsed"));assertEquals(2,chapter.getJSONArray("children").length())
        val child=chapter.getJSONArray("children").getJSONObject(0)
        val edited=replaceMindNode(root,child.getString("id"),JSONObject(child.toString()).put("text","新文字"))
        assertEquals("新文字",findMindNode(edited,child.getString("id"))!!.getString("text"))
        assertEquals("第二段",edited.getJSONArray("children").getJSONObject(0).getJSONArray("children").getJSONObject(1).getString("text"))
        assertEquals("正文 🚀",findMindNode(root,child.getString("id"))!!.getString("text"))
    }
}
