package org.shufang.android

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.selection.selectable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable fun ReadingNavigationRail(view:String,onNavigate:(String)->Unit) {
    NavigationRail(containerColor=MaterialTheme.colorScheme.background,modifier=Modifier.width(80.dp).fillMaxHeight()) {
        Spacer(Modifier.height(20.dp))
        for((key,label,icon) in listOf(Triple("books","书架",Icons.Outlined.AutoStories),Triple("notes","笔记",Icons.Outlined.Description),Triple("review","复习",Icons.Outlined.Layers),Triple("settings","设置",Icons.Outlined.Tune))) {
            NavigationRailItem(selected=view==key,onClick={onNavigate(key)},icon={Icon(icon,null)},label={Text(label)},modifier=Modifier.padding(vertical=8.dp))
        }
    }
}

/** Navigation remains opaque enough to read in both themes, without a platform blur dependency. */
@Composable fun ReadingNavigation(view:String,onNavigate:(String)->Unit) {
    Box(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal=24.dp,vertical=10.dp),contentAlignment=Alignment.Center) {
        Surface(shape=RoundedCornerShape(30.dp),color=MaterialTheme.colorScheme.surface.copy(alpha=.98f),
            border=BorderStroke(1.dp,MaterialTheme.colorScheme.outlineVariant.copy(alpha=.55f)),shadowElevation=if(LocalInkMode.current)0.dp else 8.dp) {
            Row(Modifier.widthIn(max=480.dp).fillMaxWidth().padding(6.dp)) {
                for((key,label,icon) in listOf(Triple("books","书架",Icons.Outlined.AutoStories),Triple("notes","笔记",Icons.Outlined.Description),Triple("review","复习",Icons.Outlined.Layers),Triple("settings","设置",Icons.Outlined.Tune))) {
                    val active=view==key
                    Column(Modifier.weight(1f).clip(RoundedCornerShape(24.dp)).background(if(active)MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
                        .selectable(selected=active,role=Role.Tab,onClick={onNavigate(key)}).padding(vertical=9.dp),horizontalAlignment=Alignment.CenterHorizontally,verticalArrangement=Arrangement.spacedBy(3.dp)) {
                        Icon(icon,null,Modifier.size(22.dp),tint=if(active)MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(label,fontSize=11.sp,fontWeight=if(active)FontWeight.SemiBold else FontWeight.Normal,color=if(active)MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

@Composable fun CoverArtwork(book:Record,modifier:Modifier=Modifier) {
    val data=book.text("customCover").ifBlank {book.text("cover")}
    val bitmap=remember(data){runCatching {if(data.startsWith("data:image/")){val bytes=android.util.Base64.decode(data.substringAfter(','),android.util.Base64.DEFAULT);android.graphics.BitmapFactory.decodeByteArray(bytes,0,bytes.size)?.asImageBitmap()}else null}.getOrNull()}
    val tones=listOf(Color(0xFF294C47),Color(0xFF71604A),Color(0xFF374B68),Color(0xFF75554C),Color(0xFF505465))
    val tone=if(LocalInkMode.current)Color(0xFF333333)else tones[(book.id.hashCode().toLong().let {if(it<0)-it else it}%tones.size).toInt()]
    Box(modifier.clip(RoundedCornerShape(topStart=3.dp,topEnd=10.dp,bottomEnd=10.dp,bottomStart=3.dp)).background(tone)) {
        if(bitmap!=null)Image(bitmap,null,Modifier.fillMaxSize(),contentScale=ContentScale.Crop)
        else {
            if(!LocalInkMode.current)Box(Modifier.fillMaxSize().background(Brush.linearGradient(listOf(tone,tone.copy(alpha=.65f),Color(0xFF202927)))))
            Column(Modifier.fillMaxSize().padding(start=20.dp,end=14.dp,top=20.dp,bottom=16.dp),verticalArrangement=Arrangement.SpaceBetween) {
                Column {Text("書  房  文  库",fontSize=9.sp,letterSpacing=2.sp,color=Color.White.copy(alpha=.65f));Spacer(Modifier.height(18.dp));Text(book.text("title").ifBlank {"未命名"},fontFamily=FontFamily.Serif,fontWeight=FontWeight.Medium,fontSize=21.sp,lineHeight=29.sp,color=Color.White,maxLines=4,overflow=TextOverflow.Ellipsis)}
                Text(book.text("author").ifBlank {book.text("format").uppercase()},fontSize=10.sp,color=Color.White.copy(alpha=.75f),maxLines=1,overflow=TextOverflow.Ellipsis)
            }
        }
        Box(Modifier.width(6.dp).fillMaxHeight().background(Brush.horizontalGradient(listOf(Color.Black.copy(alpha=.22f),Color.White.copy(alpha=.10f),Color.Transparent))))
    }
}

@Composable fun CollectionHeading(title:String,detail:String) {
    Column(Modifier.fillMaxWidth().padding(start=24.dp,end=24.dp,top=16.dp,bottom=4.dp)) {
        Text(title,style=MaterialTheme.typography.headlineLarge)
        Text(detail,Modifier.padding(top=9.dp),style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
