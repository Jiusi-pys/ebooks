package org.shufang.android
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class WikiLinkTest {
    @Test fun titleNavigationMatchesWebCaseInsensitiveBookPriorityAndUnknownCreation() {
        val book=Record(1,JSONObject().put("id","book").put("title","Shared Title"))
        val note=Record(1,JSONObject().put("id","note").put("title","Shared Title"))
        val data=mapOf("books" to listOf(book),"notes" to listOf(note))
        assertEquals("books" to book,wikiTarget(" shared TITLE ",data))
        assertEquals("notes" to note,wikiTarget("shared title",mapOf("notes" to listOf(note))))
        assertNull(wikiTarget("new linked note",data))
    }
}
