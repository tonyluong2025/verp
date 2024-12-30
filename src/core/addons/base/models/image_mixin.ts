import { Fields } from "../../../fields"
import { AbstractModel, MetaModel } from "../../../models"

@MetaModel.define()
class ImageMixin extends AbstractModel {
  static _module = module;
  static _name = 'image.mixin'
  static _description = "Image Mixin"

  // all image fields are base64 encoded and PIL-supported

  static image1920 = Fields.Image("Image", {maxWidth: 1920, maxHeight: 1920})

  // resized fields stored (as attachment) for performance
  static image1024 = Fields.Image("Image 1024", {related: "image1920", maxWidth: 1024, maxHeight: 1024, store: true})
  static image512 = Fields.Image("Image 512", {related: "image1920", maxWidth: 512, maxHeight: 512, store: true})
  static image256 = Fields.Image("Image 256", {related: "image1920", maxWidth: 256, maxHeight: 256, store: true})
  static image128 = Fields.Image("Image 128", {related: "image1920", maxWidth: 128, maxHeight: 128, store: true})
}