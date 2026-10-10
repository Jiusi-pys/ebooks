package org.shufang.android

import android.content.Context
import androidx.compose.runtime.saveable.Saver
import java.io.File
import java.util.UUID
import org.json.JSONObject

// Bundle stores only a private file name, keeping long drafts outside Binder limits.
fun draftStringSaver(context:Context)=Saver<String,String>(
    save={value->
        val dir=File(context.filesDir,"ui-drafts").apply {mkdirs()}
        File(dir,"${UUID.randomUUID()}.txt").apply {writeText(value)}.name
    },
    restore={name->if(Regex("[a-f0-9-]+\\.txt").matches(name))runCatching {File(context.filesDir,"ui-drafts/$name").readText()}.getOrNull() else null}
)
fun recordDraftSaver(context:Context)=Saver<Record?,String>(
    save={record->record?.let {
        val dir=File(context.filesDir,"ui-drafts").apply {mkdirs()}
        File(dir,"${UUID.randomUUID()}.txt").apply {writeText(JSONObject().put("revision",it.revision).put("value",it.value).toString())}.name
    }?:"new"},
    restore={name->if(name=="new")null else if(Regex("[a-f0-9-]+\\.txt").matches(name))runCatching {Record.from(JSONObject(File(context.filesDir,"ui-drafts/$name").readText()))}.getOrNull() else null}
)
fun jsonDraftSaver(context:Context)=Saver<JSONObject,String>(
    save={value->
        val dir=File(context.filesDir,"ui-drafts").apply {mkdirs()}
        File(dir,"${UUID.randomUUID()}.txt").apply {writeText(value.toString())}.name
    },
    restore={name->if(Regex("[a-f0-9-]+\\.txt").matches(name))runCatching {JSONObject(File(context.filesDir,"ui-drafts/$name").readText())}.getOrNull() else null}
)
