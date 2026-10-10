package org.shufang.android

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class BookEditTest {
    @Test fun readerCheckpointsCanBeRebasedButConcurrentMetadataEditsCannot() {
        val old=Record(1,JSONObject("""{"id":"book","title":"Title","metadata":{"version":1,"publisher":"Old"},"progress":{"ratio":0}}"""))
        val progressed=Record(2,JSONObject("""{"id":"book","title":"Title","progress":{"ratio":0.8},"metadata":{"publisher":"Old","version":1}}"""))
        val patch=JSONObject().put("title","New").put("metadata",JSONObject("""{"version":1,"publisher":"New"}"""))
        assertTrue(canRebaseBookEdit(old,progressed,patch))
        val changed=Record(3,JSONObject(progressed.value.toString()).put("title","Remote title"))
        assertFalse(canRebaseBookEdit(old,changed,patch))
        assertFalse(canRebaseBookEdit(old,progressed,JSONObject().put("progress",JSONObject().put("ratio",0.5))))
        assertTrue(canRebaseBookEdit(old,progressed,JSONObject().put("customCover","image")))
        assertFalse(canRebaseBookEdit(old,Record(3,JSONObject(progressed.value.toString()).put("customCover","other")),JSONObject().put("customCover","image")))
    }
}
