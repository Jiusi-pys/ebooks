package org.shufang.android

import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.lifecycle.ViewModelProvider
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.core.content.FileProvider
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.util.UUID

class StudyBackupTouchTest {
    @get:Rule val compose=createEmptyComposeRule()
    @Test fun restorePreviewCancelStaleCommitAndConfirmedSave():Unit=runBlocking {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        check(context.packageName=="org.shufang.android.acceptance")
        val scenario=ActivityScenario.launch(MainActivity::class.java);lateinit var model:LibraryViewModel
        scenario.onActivity {model=ViewModelProvider(it)[LibraryViewModel::class.java]}
        compose.waitUntil(20000){model.state.value.ready}
        val suffix=UUID.randomUUID().toString();val source=CoreRepository(context,"study-touch-$suffix");source.open()
        val note=source.save("notes",null,JSONObject().put("title","Restore touch $suffix").put("content","中文😀 UI recovery"))
        val archive=File(context.cacheDir,"shares/study-$suffix.zip");archive.parentFile!!.mkdirs()
        source.command("exportStudyBackup",JSONObject().put("path",archive.path).put("origin","offline").put("userID","local"))
        val uri=FileProvider.getUriForFile(context,"${context.packageName}.files",archive)
        var concurrent:Record?=null
        try {
            model.navigate("settings")
            model.previewStudy(uri,"keepLocal").join()
            compose.onNodeWithText("确认恢复").assertIsDisplayed()
            assertFalse(model.repository.list("notes").any {it.id==note.id})
            compose.onNodeWithText("取消",useUnmergedTree=true).performClick()
            compose.waitUntil(10000){model.state.value.studyRestorePreview==null&&model.state.value.busy.isEmpty()}
            assertFalse(model.repository.list("notes").any {it.id==note.id})
            model.previewStudy(uri,"keepLocal").join()
            concurrent=model.repository.save("notes",null,JSONObject().put("title","Concurrent $suffix").put("content","keep"))
            compose.onNodeWithText("确认恢复").performClick()
            compose.waitUntil(10000){model.state.value.error.contains("restore_preview_changed")}
            assertFalse(model.repository.list("notes").any {it.id==note.id})
            model.clearError();model.cancelStudyRestore().join();model.previewStudy(uri,"keepLocal").join()
            compose.onNodeWithText("确认恢复").performClick()
            compose.waitUntil(15000){model.state.value.studyRestorePreview==null&&model.state.value.busy.isEmpty()}
            assertEquals("中文😀 UI recovery",model.repository.get("notes",note.id).text("content"))
            assertEquals("keep",model.repository.get("notes",concurrent.id).text("content"))
        }finally {
            model.cancelStudyRestore().join()
            for(id in listOfNotNull(note.id,concurrent?.id))runCatching {model.repository.remove("notes",model.repository.get("notes",id))}
            archive.delete();source.close();scenario.close()
        }
    }
}
