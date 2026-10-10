package org.shufang.android

import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID

class StudyBackupDeviceTest {
    @Test fun jniStudyBackupRestoresOpaqueInkAndRejectsStalePreview():Unit=runBlocking {
        val context=InstrumentationRegistry.getInstrumentation().targetContext;check(context.packageName=="org.shufang.android.acceptance")
        val a=CoreRepository(context,"study-test-${UUID.randomUUID()}");val b=CoreRepository(context,"study-test-${UUID.randomUUID()}")
        try {a.open("test");b.open("test")
            val opaque=File(a.root,"drawing.bin").apply {writeBytes(byteArrayOf(0,-1,10,0,5))}
            val ref=a.command("putAttachment",JSONObject().put("path",opaque.path).put("name","drawing.bin").put("type","application/octet-stream"))
            val note=a.save("notes",null,JSONObject().put("title","学习备份😀").put("content","中文与 emoji").put("pdfDrawing",ref))
            val zip=File(a.root,"study.zip");a.command("exportStudyBackup",JSONObject().put("path",zip.path).put("origin","offline").put("userID","local"))
            val args=JSONObject().put("path",zip.path).put("origin","offline").put("userID","local").put("policy","keepLocal")
            val stale=b.command("previewStudyRestore",args)
            b.save("notes",null,JSONObject().put("title","预览后的修改").put("content","保留"))
            try {b.command("commitStudyRestore",stale);fail("Stale plan accepted")}catch(e:IllegalStateException){assertEquals("restore_preview_changed",e.message)}
            assertEquals(1,b.list("notes").size)
            val preview=b.command("previewStudyRestore",args);val result=b.command("commitStudyRestore",preview);assertTrue(File(result.getString("safetyBackup")).exists())
            assertTrue(b.command("commitStudyRestore",preview).getBoolean("duplicate"))
            b.close();b.open("test");val restored=b.get("notes",note.id);assertEquals("中文与 emoji",restored.text("content"))
            val resource=b.command("attachmentResource",JSONObject().put("reference",restored.value.getJSONObject("pdfDrawing")));assertArrayEquals(opaque.readBytes(),File(resource.getString("path")).readBytes());assertEquals(2,b.list("notes").size)
        }finally {a.close();b.close();for(repo in listOf(a,b)){check(repo.root.canonicalFile.parentFile==File(context.filesDir,"workspaces").canonicalFile&&repo.key.startsWith("study-test-"));repo.root.deleteRecursively()}}
    }
}
