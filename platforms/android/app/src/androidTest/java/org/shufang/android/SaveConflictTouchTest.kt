package org.shufang.android

import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.lifecycle.ViewModelProvider
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.UUID

class SaveConflictTouchTest {
    @get:Rule val compose=createEmptyComposeRule()
    @Test fun staleEditOffersBothCopiesAndRechecksTheLatestVersion():Unit=runBlocking {
        val context=InstrumentationRegistry.getInstrumentation().targetContext;check(context.packageName=="org.shufang.android.acceptance")
        val scenario=ActivityScenario.launch(MainActivity::class.java);lateinit var model:LibraryViewModel
        scenario.onActivity {model=ViewModelProvider(it)[LibraryViewModel::class.java]}
        compose.waitUntil(20000){model.state.value.ready}
        val suffix=UUID.randomUUID().toString();val repo=model.repository
        val original=repo.save("notes",null,JSONObject().put("title","Conflict $suffix").put("content","base"))
        try {
            val remote=repo.save("notes",original,JSONObject().put("content","other device"))
            model.save("notes",original,JSONObject().put("content","my draft")).join()
            compose.onNodeWithText("资料已被其他操作修改").assertIsDisplayed()
            assertEquals("other device",model.state.value.saveConflict!!.current.text("content"))
            compose.onNodeWithText("保留双方副本").performScrollTo().performClick()
            compose.waitUntil(10000){model.state.value.saveConflict==null&&model.state.value.busy.isEmpty()}
            val copies=repo.list("notes").filter {it.text("title")=="Conflict $suffix"};assertEquals(2,copies.size)
            assertEquals("other device",repo.get("notes",original.id).text("content"));assertTrue(copies.any {it.text("content")=="my draft"})
            model.save("notes",original,JSONObject().put("content","second draft")).join()
            repo.save("notes",remote,JSONObject().put("content","late response"))
            compose.onNodeWithText("保存我的修改").performClick()
            compose.waitUntil(10000){model.state.value.busy.isEmpty()&&model.state.value.saveConflict?.current?.text("content")=="late response"}
            assertEquals("late response",repo.get("notes",original.id).text("content"))
            // Dismiss the error banner, then explicitly accept the updated preview.
            model.clearError()
            compose.onNodeWithText("保存我的修改").performClick()
            compose.waitUntil(10000){model.state.value.saveConflict==null&&model.state.value.busy.isEmpty()}
            assertEquals("second draft",repo.get("notes",original.id).text("content"))
            model.save("notes",original,JSONObject().put("content","restart draft")).join()
            val path=model.state.value.saveConflict!!.draftPath
            model.dismissSaveConflict()
            val restarted=LibraryViewModel(context.applicationContext as android.app.Application)
            compose.waitUntil(20000){restarted.state.value.ready}
            restarted.resumeConflictDraft(path).join()
            assertEquals("restart draft",restarted.state.value.saveConflict!!.patch.getString("content"))
            restarted.resolveSaveConflict("local").join()
            assertEquals("restart draft",repo.get("notes",original.id).text("content"))
            assertFalse(java.io.File(path).exists())
        }finally {model.dismissSaveConflict();for(note in repo.list("notes").filter {it.text("title")=="Conflict $suffix"})repo.remove("notes",repo.get("notes",note.id));scenario.close()}
    }
}
